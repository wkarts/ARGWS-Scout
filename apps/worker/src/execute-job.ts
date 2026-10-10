import type { Prisma } from "@prisma/client";
import { JobStatus, PrismaClient, SourceEngine } from "@prisma/client";
import { contentSettings } from "@argws/scout-core";
import type {
  ConnectorContext,
  ConnectorResult,
  JobEnvelope,
} from "@argws/scout-core";
import { renderInputTemplate } from "@argws/scout-core";
import Redis from "ioredis";
import { createHash } from "node:crypto";
import { storeArtifact } from "@argws/scout-shared/storage";

const prisma = new PrismaClient();
const MAX_ATTEMPTS = Number(process.env.SCOUT_JOB_MAX_ATTEMPTS ?? 3);
const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379/0", {
  maxRetriesPerRequest: null,
});

async function reserveSourceSlot(
  sourceId: string,
  intervalMs: number,
): Promise<void> {
  const script =
    "local now=tonumber(ARGV[1]); local gap=tonumber(ARGV[2]); local next=tonumber(redis.call('GET',KEYS[1]) or now); local wait=math.max(0,next-now); redis.call('SET',KEYS[1],math.max(next,now)+gap,'PX',math.max(gap*5,30000)); return wait";
  const key = `scout:source-rate:${createHash("sha256").update(sourceId).digest("hex")}`;
  const waitMs = Number(
    await redis.eval(script, 1, key, Date.now(), Math.max(1000, intervalMs)),
  );
  if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
}

function safeError(error: unknown): { code: string; message: string } {
  const raw =
    error instanceof Error ? error.message : "Falha desconhecida na coleta.";
  const message = raw
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[URL]")
    .replace(
      /(authorization|cookie|token|secret)\s*[:=]\s*[^\s,;]+/gi,
      "$1=[redacted]",
    )
    .slice(0, 1000);
  return { code: "COLLECTION_FAILED", message: message || "Falha na coleta." };
}

export async function executeJob(
  envelope: JobEnvelope,
  engine: SourceEngine,
  runner: (context: ConnectorContext) => Promise<ConnectorResult>,
): Promise<void> {
  const job = await prisma.job.findFirst({
    where: { id: envelope.jobId, tenantId: envelope.tenantId },
    include: { source: true, instance: true },
  });
  if (
    !job ||
    job.status !== JobStatus.QUEUED ||
    job.source.engine !== engine ||
    !job.source.enabled
  )
    return;
  const claim = await prisma.job.updateMany({
    where: { id: job.id, status: JobStatus.QUEUED },
    data: {
      status: JobStatus.RUNNING,
      startedAt: new Date(),
      attempts: { increment: 1 },
    },
  });
  if (!claim.count) return;
  const attempt = job.attempts + 1;
  const attemptRow = await prisma.jobAttempt.create({
    data: { jobId: job.id, attempt, status: "RUNNING" },
  });
  try {
    await reserveSourceSlot(job.source.id, job.source.requestIntervalMs);
    const input =
      job.input && typeof job.input === "object" && !Array.isArray(job.input)
        ? (job.input as Record<string, unknown>)
        : {};
    const source = {
      url: renderInputTemplate(job.source.urlTemplate, input),
      allowedHosts: job.source.allowedHosts,
      selector: job.source.selector ?? undefined,
      respectRobots: job.source.respectRobots,
      captureScreenshot: job.source.captureScreenshot,
    };
    const rawResult = await runner({ input, source });
    const resultData = { ...rawResult.data };
    let artifact: Awaited<ReturnType<typeof storeArtifact>> | null = null;
    if (typeof resultData.screenshotBase64 === "string") {
      const bytes = Buffer.from(resultData.screenshotBase64, "base64");
      delete resultData.screenshotBase64;
      if (bytes.byteLength > 500_000)
        throw new Error("Screenshot excedeu o limite permitido.");
      artifact = await storeArtifact({
        tenantId: job.tenantId,
        jobId: job.id,
        fileName: "capture.png",
        contentType: "image/png",
        bytes,
      });
      resultData.screenshotArtifact = {
        id: artifact.id,
        kind: "screenshot",
        fileName: "capture.png",
        contentType: "image/png",
        sizeBytes: artifact.sizeBytes,
        sha256: artifact.sha256,
      };
    }
    const result: ConnectorResult = { ...rawResult, data: resultData };
    const event = {
      id: undefined as unknown as string,
      type: "job.completed",
      createdAt: new Date().toISOString(),
      tenantId: job.tenantId,
      instanceId: job.instanceId,
      jobId: job.id,
      data: { status: "SUCCEEDED", result },
    };
    await prisma.$transaction(async (tx) => {
      await tx.job.update({
        where: { id: job.id },
        data: {
          status: JobStatus.SUCCEEDED,
          result: result as unknown as Prisma.InputJsonValue,
          finishedAt: new Date(),
          errorCode: null,
          errorMessage: null,
        },
      });
      await tx.jobAttempt.update({
        where: { id: attemptRow.id },
        data: { status: "SUCCEEDED", finishedAt: new Date() },
      });
      // A coleta nunca depende do serviço de conteúdo. Apenas coloca um
      // evento na outbox se o operador ativou o refinamento desta instância.
      const content = contentSettings(job.instance.metadata);
      if (process.env.SCOUT_CONTENT_ENABLED === "true" && content.autoProcess) {
        const batch = await tx.contentBatch.upsert({
          where: { jobId: job.id },
          create: {
            tenantId: job.tenantId, instanceId: job.instanceId,
            jobId: job.id, options: content,
          },
          update: {},
        });
        await tx.outbox.create({
          data: {
            tenantId: job.tenantId,
            eventType: "content.refine",
            routingKey: "content.refine",
            aggregateId: batch.id,
            payload: { batchId: batch.id, tenantId: job.tenantId },
          },
        });
      }
      if (artifact)
        await tx.artifact.create({
          data: {
            id: artifact.id,
            jobId: job.id,
            kind: "screenshot",
            objectKey: artifact.objectKey,
            fileName: "capture.png",
            contentType: "image/png",
            sha256: artifact.sha256,
            sizeBytes: artifact.sizeBytes,
          },
        });
      const outbox = await tx.outbox.create({
        data: {
          tenantId: job.tenantId,
          eventType: "job.completed",
          routingKey: "domain.event",
          aggregateId: job.id,
          payload: event as unknown as Prisma.InputJsonValue,
        },
      });
      await tx.outbox.update({
        where: { id: outbox.id },
        data: {
          payload: {
            ...event,
            id: outbox.id,
          } as unknown as Prisma.InputJsonValue,
        },
      });
    });
  } catch (error) {
    const safe = safeError(error);
    const retrying = attempt < MAX_ATTEMPTS;
    const nextAttemptAt = new Date(
      Date.now() + Math.min(300_000, 2 ** attempt * 5000),
    );
    const eventType = retrying ? "job.retrying" : "job.failed";
    const event = {
      type: eventType,
      createdAt: new Date().toISOString(),
      tenantId: job.tenantId,
      instanceId: job.instanceId,
      jobId: job.id,
      data: { status: retrying ? "QUEUED" : "FAILED", error: safe },
    };
    await prisma.$transaction(async (tx) => {
      await tx.job.update({
        where: { id: job.id },
        data: {
          status: retrying ? JobStatus.QUEUED : JobStatus.FAILED,
          errorCode: safe.code,
          errorMessage: safe.message,
          ...(retrying ? { startedAt: null } : { finishedAt: new Date() }),
        },
      });
      await tx.jobAttempt.update({
        where: { id: attemptRow.id },
        data: {
          status: "FAILED",
          finishedAt: new Date(),
          errorCode: safe.code,
          errorMessage: safe.message,
        },
      });
      if (retrying) {
        await tx.outbox.create({
          data: {
            tenantId: job.tenantId,
            eventType: "job.execute",
            routingKey:
              engine === SourceEngine.HTTP ? "jobs.http" : "jobs.browser",
            aggregateId: job.id,
            payload: { jobId: job.id, tenantId: job.tenantId, engine },
            nextAttemptAt,
          },
        });
      } else {
        const outbox = await tx.outbox.create({
          data: {
            tenantId: job.tenantId,
            eventType,
            routingKey: "domain.event",
            aggregateId: job.id,
            payload: event as unknown as Prisma.InputJsonValue,
          },
        });
        await tx.outbox.update({
          where: { id: outbox.id },
          data: {
            payload: {
              ...event,
              id: outbox.id,
            } as unknown as Prisma.InputJsonValue,
          },
        });
      }
    });
  }
}

export async function closeWorker(): Promise<void> {
  redis.disconnect();
  await prisma.$disconnect();
}
