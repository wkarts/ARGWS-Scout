import "dotenv/config";
import amqp from "amqplib";
import {
  JobStatus,
  Prisma,
  PrismaClient,
  ContentBatchStatus,
} from "@prisma/client";
import { QUEUES } from "@argws/scout-core";

const prisma = new PrismaClient();
const rabbitUrl = process.env.RABBITMQ_URL;
if (!rabbitUrl) throw new Error("RABBITMQ_URL não configurada.");
const connection = await amqp.connect(rabbitUrl);
const channel = await connection.createConfirmChannel();
for (const queue of Object.values(QUEUES))
  await channel.assertQueue(queue, { durable: true });
let running = true;

async function shutdown(): Promise<void> {
  running = false;
  await channel.close().catch(() => undefined);
  await connection.close().catch(() => undefined);
  await prisma.$disconnect();
  process.exit(0);
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

const pollMs = Math.max(
  250,
  Number(process.env.SCOUT_DISPATCHER_POLL_MS ?? 1000),
);
const maxJobAttempts = Math.max(
  1,
  Number(process.env.SCOUT_JOB_MAX_ATTEMPTS ?? 3),
);

// Recuperação isolada da camada opcional; não altera coletas nem os workers existentes.
async function recoverStalledContentBatches(): Promise<void> {
  if (process.env.SCOUT_CONTENT_ENABLED !== "true") return;
  const now = new Date();
  // Processamento de imagens/redes pode demorar, por isso o lease é conservador.
  const staleBefore = new Date(now.getTime() - 45 * 60_000);
  const stale = await prisma.contentBatch.findMany({
    where: {
      status: ContentBatchStatus.RUNNING,
      updatedAt: { lt: staleBefore },
    },
    take: 20,
    orderBy: { updatedAt: "asc" },
  });
  for (const batch of stale) {
    await prisma.$transaction(async (tx) => {
      const failed = batch.attempts >= 3;
      const claimed = await tx.contentBatch.updateMany({
        where: {
          id: batch.id,
          status: ContentBatchStatus.RUNNING,
          updatedAt: batch.updatedAt,
        },
        data: {
          status: failed
            ? ContentBatchStatus.FAILED
            : ContentBatchStatus.QUEUED,
          errorCode: "CONTENT_WORKER_TIMEOUT",
          startedAt: null,
          ...(failed ? { finishedAt: now } : {}),
        },
      });
      if (!claimed.count || failed) return;
      await tx.outbox.create({
        data: {
          tenantId: batch.tenantId,
          eventType: "content.refine",
          routingKey: "content.refine",
          aggregateId: batch.id,
          payload: { batchId: batch.id, tenantId: batch.tenantId },
        },
      });
    });
  }
}

async function recoverStalledJobs(): Promise<void> {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - 120_000);
  const stalled = await prisma.job.findMany({
    where: { status: JobStatus.RUNNING, startedAt: { lt: staleBefore } },
    include: { source: true },
    take: 50,
    orderBy: { startedAt: "asc" },
  });
  for (const job of stalled) {
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.job.updateMany({
        where: {
          id: job.id,
          status: JobStatus.RUNNING,
          startedAt: job.startedAt,
        },
        data: {
          status:
            job.attempts >= maxJobAttempts
              ? JobStatus.FAILED
              : JobStatus.QUEUED,
          startedAt: null,
          ...(job.attempts >= maxJobAttempts
            ? {
                finishedAt: now,
                errorCode: "WORKER_TIMEOUT",
                errorMessage:
                  "O worker não concluiu a execução dentro do prazo de recuperação.",
              }
            : {}),
        },
      });
      if (!claimed.count) return;
      await tx.jobAttempt.updateMany({
        where: { jobId: job.id, status: "RUNNING" },
        data: {
          status: "FAILED",
          finishedAt: now,
          errorCode: "WORKER_TIMEOUT",
          errorMessage: "Worker interrompido antes de registrar o resultado.",
        },
      });
      if (job.attempts >= maxJobAttempts) {
        const event = {
          type: "job.failed",
          createdAt: now.toISOString(),
          tenantId: job.tenantId,
          instanceId: job.instanceId,
          jobId: job.id,
          data: {
            status: "FAILED",
            error: {
              code: "WORKER_TIMEOUT",
              message: "Tentativas esgotadas após interrupção do worker.",
            },
          },
        };
        const outbox = await tx.outbox.create({
          data: {
            tenantId: job.tenantId,
            eventType: "job.failed",
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
      } else {
        await tx.outbox.create({
          data: {
            tenantId: job.tenantId,
            eventType: "job.execute",
            routingKey:
              job.source.engine === "HTTP" ? "jobs.http" : "jobs.browser",
            aggregateId: job.id,
            nextAttemptAt: new Date(now.getTime() + 5000),
            payload: {
              jobId: job.id,
              tenantId: job.tenantId,
              engine: job.source.engine,
            },
          },
        });
      }
    });
  }
}

async function dispatchOutbox(): Promise<void> {
  const rows = await prisma.outbox.findMany({
    where: { publishedAt: null, nextAttemptAt: { lte: new Date() } },
    orderBy: { createdAt: "asc" },
    take: 50,
  });
  for (const row of rows) {
    try {
      if (row.routingKey === "domain.event") {
        const payload = row.payload as Record<string, unknown>;
        const instanceId = String(payload.instanceId ?? "");
        const eventType = String(payload.type ?? row.eventType);
        if (instanceId && ["job.completed", "job.failed"].includes(eventType)) {
          const hooks = await prisma.webhook.findMany({
            where: {
              tenantId: row.tenantId ?? undefined,
              enabled: true,
              events: { has: eventType },
              OR: [{ instanceId }, { instanceId: null }],
            },
          });
          await prisma.webhookDelivery.createMany({
            data: hooks.map((webhook) => ({
              webhookId: webhook.id,
              eventId: row.id,
              eventType,
              payload: { ...payload, id: row.id } as Prisma.InputJsonValue,
            })),
            skipDuplicates: true,
          });
        }
      } else {
        const queue =
          row.routingKey === "content.refine"
            ? QUEUES.content
            : row.routingKey === "jobs.browser"
              ? QUEUES.browser
              : row.routingKey === "jobs.http"
                ? QUEUES.http
                : null;
        if (queue)
          channel.sendToQueue(queue, Buffer.from(JSON.stringify(row.payload)), {
            persistent: true,
            contentType: "application/json",
            messageId: row.id,
          });
        else throw new Error(`Routing key desconhecida: ${row.routingKey}`);
      }
      await channel.waitForConfirms();
      await prisma.outbox.update({
        where: { id: row.id },
        data: { publishedAt: new Date(), lastError: null },
      });
    } catch (error) {
      const retry = Math.min(60_000, 1000 * 2 ** Math.min(row.attempts, 6));
      await prisma.outbox.update({
        where: { id: row.id },
        data: {
          attempts: { increment: 1 },
          nextAttemptAt: new Date(Date.now() + retry),
          lastError: (error instanceof Error
            ? error.message
            : "dispatch failed"
          ).slice(0, 1000),
        },
      });
    }
  }
}

async function dispatchWebhooks(): Promise<void> {
  const now = new Date();
  await prisma.webhookDelivery.updateMany({
    where: { status: "SENDING", leaseUntil: { lte: now } },
    data: {
      status: "PENDING",
      leaseUntil: null,
      nextAttemptAt: now,
      lastError: "Recovered expired delivery lease.",
    },
  });
  const due = await prisma.webhookDelivery.findMany({
    where: {
      status: "PENDING",
      nextAttemptAt: { lte: now },
      OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }],
    },
    take: 50,
    orderBy: { nextAttemptAt: "asc" },
  });
  for (const delivery of due) {
    const leaseUntil = new Date(Date.now() + 60_000);
    const claimed = await prisma.webhookDelivery.updateMany({
      where: {
        id: delivery.id,
        status: "PENDING",
        OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }],
      },
      data: { leaseUntil },
    });
    if (!claimed.count) continue;
    channel.sendToQueue(
      QUEUES.webhooks,
      Buffer.from(JSON.stringify({ deliveryId: delivery.id })),
      {
        persistent: true,
        contentType: "application/json",
        messageId: delivery.id,
      },
    );
    await channel.waitForConfirms();
  }
}

let lastContentRecovery = 0;
while (running) {
  try {
    await recoverStalledJobs();
    if (Date.now() - lastContentRecovery >= 60_000) {
      await recoverStalledContentBatches();
      lastContentRecovery = Date.now();
    }
    await dispatchOutbox();
    await dispatchWebhooks();
  } catch (error) {
    process.stderr.write(
      `Dispatcher: ${error instanceof Error ? error.message : "falha"}\n`,
    );
  }
  await new Promise((resolve) => setTimeout(resolve, pollMs));
}
