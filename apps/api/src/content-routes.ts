import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import {
  ContentBatchStatus,
  ContentReviewStatus,
  JobStatus,
  Prisma,
  TenantRole,
} from "@prisma/client";
import { z } from "zod";
import { contentSettings } from "@argws/scout-core";
import { getArtifactStream } from "@argws/scout-shared/storage";
import { authenticated, hasRole, isManagerUser } from "./auth.ts";
import { prisma } from "./db.ts";
import { audit } from "./audit.ts";

const uuid = z.string().uuid();
const settingsSchema = z
  .object({
    autoProcess: z.boolean().optional(),
    query: z.string().trim().max(150).optional(),
    onlyRelevant: z.boolean().optional(),
    maxItems: z.number().int().min(1).max(250).optional(),
    createStory: z.boolean().optional(),
    fetchImages: z.boolean().optional(),
    enrichImages: z.boolean().optional(),
  })
  .strict();
const contentOptions = settingsSchema.omit({ autoProcess: true });
const roles = [TenantRole.OWNER, TenantRole.ADMIN, TenantRole.OPERATOR];
const adminRoles = [TenantRole.OWNER, TenantRole.ADMIN];
function fail(
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
) {
  return reply.code(status).send({ error: { code, message } });
}
function canRead(request: FastifyRequest, reply: FastifyReply): boolean {
  if (!isManagerUser(request)) {
    fail(
      reply,
      403,
      "FORBIDDEN",
      "Este recurso exige acesso de usuário ao espaço de trabalho.",
    );
    return false;
  }
  return true;
}
function canOperate(request: FastifyRequest, reply: FastifyReply): boolean {
  if (!canRead(request, reply)) return false;
  if (!hasRole(request, ...roles)) {
    fail(reply, 403, "FORBIDDEN", "Permissão de operação necessária.");
    return false;
  }
  return true;
}
function canAdmin(request: FastifyRequest, reply: FastifyReply): boolean {
  if (!canRead(request, reply)) return false;
  if (!hasRole(request, ...adminRoles)) {
    fail(reply, 403, "FORBIDDEN", "Permissão de administrador necessária.");
    return false;
  }
  return true;
}
function tid(request: FastifyRequest): string {
  return request.principal!.tenantId;
}
function featureAvailable(reply: FastifyReply): boolean {
  if (process.env.SCOUT_CONTENT_ENABLED !== "true") {
    fail(
      reply,
      503,
      "CONTENT_DISABLED",
      "Ative o módulo de conteúdo no ambiente da plataforma.",
    );
    return false;
  }
  return true;
}
async function enqueue(
  tx: Prisma.TransactionClient,
  batch: { id: string; tenantId: string },
) {
  await tx.outbox.create({
    data: {
      tenantId: batch.tenantId,
      eventType: "content.refine",
      routingKey: "content.refine",
      aggregateId: batch.id,
      payload: { batchId: batch.id, tenantId: batch.tenantId },
    },
  });
}
async function startBatch(
  jobId: string,
  tenantId: string,
  instanceId: string,
  options: Prisma.InputJsonValue,
) {
  return prisma.$transaction(async (tx) => {
    const previous = await tx.contentBatch.findUnique({ where: { jobId } });
    if (previous) {
      if (previous.status !== ContentBatchStatus.FAILED)
        return { batch: previous, reused: true };
      const updated = await tx.contentBatch.updateMany({
        where: { id: previous.id, status: ContentBatchStatus.FAILED },
        data: {
          status: ContentBatchStatus.QUEUED,
          options,
          attempts: 0,
          startedAt: null,
          finishedAt: null,
          errorCode: null,
        },
      });
      if (!updated.count)
        return {
          batch: await tx.contentBatch.findUniqueOrThrow({
            where: { id: previous.id },
          }),
          reused: true,
        };
      await enqueue(tx, previous);
      return {
        batch: await tx.contentBatch.findUniqueOrThrow({
          where: { id: previous.id },
        }),
        reused: false,
      };
    }
    const batch = await tx.contentBatch.create({
      data: { jobId, tenantId, instanceId, options },
    });
    await enqueue(tx, batch);
    return { batch, reused: false };
  });
}
export async function registerContentRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.get(
    "/content/status",
    { preHandler: authenticated() },
    async (request, reply) => {
      if (!canRead(request, reply)) return;
      return {
        enabled: process.env.SCOUT_CONTENT_ENABLED === "true",
        autoPublish: false,
        maxItems: 250,
        channels: [
          "whatsapp",
          "email",
          "telegram",
          "instagram",
          "facebook",
          "linkedin",
          "sms",
        ],
      };
    },
  );
  app.get(
    "/content/instances/:id/settings",
    { preHandler: authenticated() },
    async (request, reply) => {
      if (!canRead(request, reply)) return;
      const { id } = request.params as { id: string };
      if (!uuid.safeParse(id).success)
        return fail(reply, 400, "INVALID_ID", "Identificador inválido.");
      const instance = await prisma.instance.findFirst({
        where: { id, tenantId: tid(request) },
      });
      if (!instance)
        return fail(
          reply,
          404,
          "INSTANCE_NOT_FOUND",
          "Instância não encontrada.",
        );
      return { instanceId: id, settings: contentSettings(instance.metadata) };
    },
  );
  app.patch(
    "/content/instances/:id/settings",
    { preHandler: authenticated() },
    async (request, reply) => {
      if (!canAdmin(request, reply)) return;
      const { id } = request.params as { id: string };
      if (!uuid.safeParse(id).success)
        return fail(reply, 400, "INVALID_ID", "Identificador inválido.");
      const parsed = settingsSchema.safeParse(request.body);
      if (!parsed.success)
        return fail(
          reply,
          400,
          "INVALID_SETTINGS",
          "Revise as configurações informadas.",
        );
      const instance = await prisma.instance.findFirst({
        where: { id, tenantId: tid(request) },
      });
      if (!instance)
        return fail(
          reply,
          404,
          "INSTANCE_NOT_FOUND",
          "Instância não encontrada.",
        );
      const metadata =
        instance.metadata &&
        typeof instance.metadata === "object" &&
        !Array.isArray(instance.metadata)
          ? (instance.metadata as Record<string, unknown>)
          : {};
      const settings = {
        ...contentSettings(instance.metadata),
        ...parsed.data,
      };
      await prisma.instance.update({
        where: { id },
        data: {
          metadata: { ...metadata, content: settings } as Prisma.InputJsonValue,
        },
      });
      await audit({
        tenantId: tid(request),
        actorUserId: request.principal!.userId,
        action: "content.settings.changed",
        resourceType: "instance",
        resourceId: id,
        metadata: { autoProcess: settings.autoProcess },
      });
      return { instanceId: id, settings };
    },
  );
  app.get(
    "/content/jobs",
    { preHandler: authenticated() },
    async (request, reply) => {
      if (!canRead(request, reply)) return;
      const query = z
        .object({ instanceId: uuid.optional() })
        .safeParse(request.query);
      if (!query.success)
        return fail(reply, 400, "INVALID_QUERY", "Filtro inválido.");
      const data = await prisma.job.findMany({
        where: {
          tenantId: tid(request),
          status: JobStatus.SUCCEEDED,
          ...(query.data.instanceId
            ? { instanceId: query.data.instanceId }
            : {}),
        },
        select: {
          id: true,
          instanceId: true,
          createdAt: true,
          finishedAt: true,
          instance: { select: { name: true } },
          source: { select: { name: true } },
          contentBatch: { select: { id: true, status: true, total: true } },
        },
        orderBy: { createdAt: "desc" },
        take: 100,
      });
      return { data };
    },
  );
  app.post(
    "/content/jobs/:jobId/refine",
    {
      preHandler: authenticated(),
      config: { rateLimit: { max: 12, timeWindow: "15 minutes" } },
    },
    async (request, reply) => {
      if (!canOperate(request, reply) || !featureAvailable(reply)) return;
      const { jobId } = request.params as { jobId: string };
      if (!uuid.safeParse(jobId).success)
        return fail(reply, 400, "INVALID_ID", "Identificador inválido.");
      const parsed = contentOptions.safeParse(request.body ?? {});
      if (!parsed.success)
        return fail(
          reply,
          400,
          "INVALID_OPTIONS",
          "Parâmetros do refinamento inválidos.",
        );
      const job = await prisma.job.findFirst({
        where: {
          id: jobId,
          tenantId: tid(request),
          status: JobStatus.SUCCEEDED,
        },
        include: { instance: true },
      });
      if (!job || !job.result)
        return fail(
          reply,
          404,
          "JOB_NOT_FOUND",
          "Coleta concluída não encontrada.",
        );
      const options = {
        ...contentSettings(job.instance.metadata),
        ...parsed.data,
      };
      const result = await startBatch(
        job.id,
        job.tenantId,
        job.instanceId,
        options as Prisma.InputJsonValue,
      );
      await audit({
        tenantId: tid(request),
        actorUserId: request.principal!.userId,
        action: "content.refinement.requested",
        resourceType: "content-batch",
        resourceId: result.batch.id,
      });
      return reply
        .code(result.reused ? 200 : 202)
        .send({ batch: result.batch, reused: result.reused });
    },
  );
  // Importações manuais ficam rastreáveis como Job SUCCEEDED, mas não executam scraping.
  app.post(
    "/content/import",
    {
      preHandler: authenticated(),
      config: { rateLimit: { max: 5, timeWindow: "15 minutes" } },
      bodyLimit: 2 * 1024 * 1024,
    },
    async (request, reply) => {
      if (!canOperate(request, reply) || !featureAvailable(reply)) return;
      const parsed = z
        .object({
          instanceId: uuid,
          sourceId: uuid,
          payload: z.unknown(),
          options: contentOptions.optional(),
        })
        .strict()
        .safeParse(request.body);
      if (!parsed.success)
        return fail(
          reply,
          400,
          "INVALID_IMPORT",
          "Informe uma instância, fonte e JSON válido.",
        );
      const { instanceId, sourceId, payload, options: overrides } = parsed.data;
      if (!payload || typeof payload !== "object" || Array.isArray(payload))
        return fail(
          reply,
          400,
          "INVALID_IMPORT",
          "A captura deve ser um objeto JSON.",
        );
      const source = await prisma.source.findFirst({
        where: {
          id: sourceId,
          instanceId,
          instance: { tenantId: tid(request) },
        },
        include: { instance: true },
      });
      if (!source)
        return fail(
          reply,
          404,
          "SOURCE_NOT_FOUND",
          "Fonte da instância não encontrada.",
        );
      const opts = {
        ...contentSettings(source.instance.metadata),
        ...(overrides ?? {}),
      };
      const job = await prisma.job.create({
        data: {
          tenantId: tid(request),
          instanceId,
          sourceId,
          createdById: request.principal!.userId,
          status: JobStatus.SUCCEEDED,
          input: { imported: true },
          result: payload as Prisma.InputJsonValue,
          startedAt: new Date(),
          finishedAt: new Date(),
        },
      });
      const result = await startBatch(
        job.id,
        job.tenantId,
        job.instanceId,
        opts as Prisma.InputJsonValue,
      );
      await audit({
        tenantId: tid(request),
        actorUserId: request.principal!.userId,
        action: "content.capture.imported",
        resourceType: "job",
        resourceId: job.id,
      });
      return reply.code(202).send({ jobId: job.id, batch: result.batch });
    },
  );
  // Reprocessa uma captura sem sobrescrever aprovações, legendas ou artes do
  // lote anterior. É uma ação explícita: visitar sites consome recursos.
  app.post(
    "/content/batches/:id/refresh-images",
    {
      preHandler: authenticated(),
      config: { rateLimit: { max: 3, timeWindow: "15 minutes" } },
    },
    async (request, reply) => {
      if (!canOperate(request, reply) || !featureAvailable(reply)) return;
      const { id } = request.params as { id: string };
      if (!uuid.safeParse(id).success)
        return fail(reply, 400, "INVALID_ID", "Lote inválido.");
      const original = await prisma.contentBatch.findFirst({
        where: { id, tenantId: tid(request) },
        include: { job: true },
      });
      if (!original || original.job.status !== JobStatus.SUCCEEDED || !original.job.result)
        return fail(reply, 404, "BATCH_NOT_FOUND", "Coleta original indisponível.");
      if (original.status === ContentBatchStatus.QUEUED || original.status === ContentBatchStatus.RUNNING)
        return fail(reply, 409, "BATCH_RUNNING", "Aguarde o processamento atual.");

      const previous = original.options as Record<string, unknown> | null;
      const options: Prisma.InputJsonValue = {
        ...(previous && typeof previous === "object" && !Array.isArray(previous) ? previous : {}),
        fetchImages: true,
        enrichImages: true,
      };
      const copy = await prisma.$transaction(async (tx) => {
        const job = await tx.job.create({
          data: {
            tenantId: original.tenantId,
            instanceId: original.instanceId,
            sourceId: original.job.sourceId,
            createdById: request.principal!.userId,
            status: JobStatus.SUCCEEDED,
            input: { refreshImagesFrom: original.jobId },
            result: original.job.result as Prisma.InputJsonValue,
            startedAt: new Date(),
            finishedAt: new Date(),
          },
        });
        const batch = await tx.contentBatch.create({
          data: {
            jobId: job.id,
            tenantId: original.tenantId,
            instanceId: original.instanceId,
            options,
          },
        });
        await enqueue(tx, batch);
        return { jobId: job.id, batch };
      });
      await audit({
        tenantId: tid(request),
        actorUserId: request.principal!.userId,
        action: "content.images.refresh_requested",
        resourceType: "content-batch",
        resourceId: copy.batch.id,
        metadata: { previousBatchId: original.id },
      });
      return reply.code(202).send(copy);
    },
  );
  app.get(
    "/content/batches",
    { preHandler: authenticated() },
    async (request, reply) => {
      if (!canRead(request, reply)) return;
      const query = z
        .object({ instanceId: uuid.optional() })
        .safeParse(request.query);
      if (!query.success)
        return fail(reply, 400, "INVALID_QUERY", "Filtro inválido.");
      const data = await prisma.contentBatch.findMany({
        where: {
          tenantId: tid(request),
          ...(query.data.instanceId
            ? { instanceId: query.data.instanceId }
            : {}),
        },
        include: {
          instance: { select: { name: true } },
          job: { select: { source: { select: { name: true } } } },
          _count: { select: { entries: true } },
        },
        orderBy: { createdAt: "desc" },
        take: 100,
      });
      return { data };
    },
  );
  app.get(
    "/content/batches/:id",
    { preHandler: authenticated() },
    async (request, reply) => {
      if (!canRead(request, reply)) return;
      const { id } = request.params as { id: string };
      if (!uuid.safeParse(id).success)
        return fail(reply, 400, "INVALID_ID", "Identificador inválido.");
      const batch = await prisma.contentBatch.findFirst({
        where: { id, tenantId: tid(request) },
        include: {
          entries: { orderBy: { createdAt: "asc" }, take: 250 },
          instance: { select: { name: true } },
          job: { select: { source: { select: { name: true } } } },
        },
      });
      if (!batch)
        return fail(reply, 404, "BATCH_NOT_FOUND", "Lote não encontrado.");
      return { batch };
    },
  );
  app.get(
    "/content/identities/:id/history",
    { preHandler: authenticated() },
    async (request, reply) => {
      if (!canRead(request, reply)) return;
      const { id } = request.params as { id: string };
      if (!uuid.safeParse(id).success)
        return fail(reply, 400, "INVALID_ID", "Identificador inválido.");
      const identity = await prisma.contentIdentity.findFirst({
        where: { id, tenantId: tid(request) },
        include: {
          observations: { orderBy: { observedAt: "desc" }, take: 100 },
        },
      });
      if (!identity)
        return fail(
          reply,
          404,
          "IDENTITY_NOT_FOUND",
          "Conteúdo não encontrado.",
        );
      return { identity };
    },
  );
  app.patch(
    "/content/items/:id/review",
    { preHandler: authenticated() },
    async (request, reply) => {
      if (!canOperate(request, reply)) return;
      const { id } = request.params as { id: string };
      const input = z
        .object({ status: z.enum(["DRAFT", "APPROVED", "ARCHIVED"]) })
        .strict()
        .safeParse(request.body);
      if (!uuid.safeParse(id).success || !input.success)
        return fail(reply, 400, "INVALID_REVIEW", "Revise a aprovação.");
      const item = await prisma.contentEntry.findFirst({
        where: { id, batch: { tenantId: tid(request) } },
      });
      if (!item)
        return fail(
          reply,
          404,
          "CONTENT_NOT_FOUND",
          "Publicação não encontrada.",
        );
      if (
        input.data.status === "APPROVED" &&
        item.reviewStatus === ContentReviewStatus.REVIEW &&
        !hasRole(request, ...adminRoles)
      )
        return fail(
          reply,
          403,
          "REVIEW_REQUIRES_ADMIN",
          "Item com divergências exige aprovação de administrador.",
        );
      const updated = await prisma.contentEntry.update({
        where: { id },
        data: {
          reviewStatus: input.data.status as ContentReviewStatus,
          reviewedById: request.principal!.userId,
          reviewedAt: new Date(),
        },
      });
      await audit({
        tenantId: tid(request),
        actorUserId: request.principal!.userId,
        action: "content.publication.reviewed",
        resourceType: "content-entry",
        resourceId: id,
        metadata: { status: updated.reviewStatus },
      });
      return { item: updated };
    },
  );
  app.get(
    "/content/items/:id/export",
    { preHandler: authenticated() },
    async (request, reply) => {
      if (!canRead(request, reply)) return;
      const { id } = request.params as { id: string };
      if (!uuid.safeParse(id).success)
        return fail(reply, 400, "INVALID_ID", "Identificador inválido.");
      const item = await prisma.contentEntry.findFirst({
        where: { id, batch: { tenantId: tid(request) } },
      });
      if (!item)
        return fail(
          reply,
          404,
          "CONTENT_NOT_FOUND",
          "Publicação não encontrada.",
        );
      return {
        itemId: id,
        reviewStatus: item.reviewStatus,
        requiresApproval: item.reviewStatus !== ContentReviewStatus.APPROVED,
        data: item.normalized,
        channels: item.channels,
        warnings: item.warnings,
        media: {
          square: `/content/items/${id}/media/square`,
          wide: `/content/items/${id}/media/wide`,
          original: `/content/items/${id}/media/original`,
          story: `/content/items/${id}/media/story`,
          eml: `/content/items/${id}/media/eml`,
        },
        sent: false,
      };
    },
  );
  app.get(
    "/content/items/:id/media/:kind",
    { preHandler: authenticated() },
    async (request, reply) => {
      if (!canRead(request, reply)) return;
      const { id, kind } = request.params as { id: string; kind: string };
      if (
        !uuid.safeParse(id).success ||
        !["square", "wide", "story", "original", "eml"].includes(kind)
      )
        return fail(reply, 404, "FILE_NOT_FOUND", "Mídia não encontrada.");
      const item = await prisma.contentEntry.findFirst({
        where: { id, batch: { tenantId: tid(request) } },
        select: { images: true, batch: { select: { jobId: true } } },
      });
      if (!item)
        return fail(reply, 404, "FILE_NOT_FOUND", "Mídia não encontrada.");
      const images = item.images as Record<string, unknown>;
      const artifactId = images?.[kind];
      if (typeof artifactId !== "string" || !uuid.safeParse(artifactId).success)
        return fail(
          reply,
          404,
          "FILE_NOT_FOUND",
          "Arquivo ainda não produzido.",
        );
      const artifact = await prisma.artifact.findFirst({
        where: { id: artifactId, jobId: item.batch.jobId },
      });
      if (!artifact)
        return fail(reply, 404, "FILE_NOT_FOUND", "Arquivo não encontrado.");
      const object = await getArtifactStream(artifact.objectKey);
      return reply
        .header("content-type", artifact.contentType)
        .header("cache-control", "private, no-store")
        .header("x-content-type-options", "nosniff")
        .header("content-security-policy", "default-src 'none'")
        .header(
          "content-disposition",
          kind === "eml"
            ? 'attachment; filename="publicacao.eml"'
            : `inline; filename="${kind}.${kind === "original" ? "webp" : "png"}"`,
        )
        .send(object.Body as never);
    },
  );
}
