import { createHash } from "node:crypto";
import { isIP } from "node:net";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Prisma, TenantRole } from "@prisma/client";
import { z } from "zod";
import { decryptSecret } from "@argws/scout-shared/crypto";
import { audit } from "./audit.ts";
import { authenticated, hasRole, isManagerUser } from "./auth.ts";
import { prisma } from "./db.ts";
import {
  connectApiRequest,
  connectInstancePath,
  connectSendTextPath,
  ConnectApiError,
  sanitizeConnectApiResponse,
  sendWhatsAppTextPayload,
} from "./connect-api.ts";
import { globalConnectSettings } from "./global-connect.ts";

const readableRoles = [TenantRole.OWNER, TenantRole.ADMIN, TenantRole.OPERATOR];
const managerialRoles = [TenantRole.OWNER, TenantRole.ADMIN];
const remoteName = z
  .string()
  .min(2)
  .max(120)
  .regex(/^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u);
const e164Digits = z.string().regex(/^[1-9][0-9]{7,14}$/);
const idempotency = /^[a-zA-Z0-9._:-]{8,80}$/;
const statusSchema = z
  .object({
    type: z.enum(["text", "image"]),
    content: z.string().trim().min(1).max(4096),
    caption: z.string().trim().max(1024).optional(),
    backgroundColor: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .default("#1d4ed8"),
    font: z.number().int().min(1).max(5).default(1),
    statusJidList: z.array(e164Digits).max(100).optional(),
    allContacts: z.boolean().default(false),
    confirmed: z.literal(true),
  })
  .strict();
const shareSchema = z
  .object({
    number: e164Digits,
    title: z.string().trim().min(2).max(280),
    productUrl: z.string().url().max(2048),
    description: z.string().trim().max(1500).optional(),
    confirmed: z.literal(true),
  })
  .strict();
type ActionRequest = {
  kind: "STATUS" | "CATALOG_SHARE";
  payload: Record<string, unknown>;
  remotePath: string;
};
function fail(
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
) {
  return reply.code(status).send({ error: { code, message } });
}
function allow(
  request: FastifyRequest,
  reply: FastifyReply,
  roles: TenantRole[],
) {
  if (!isManagerUser(request) || !hasRole(request, ...roles)) {
    fail(reply, 403, "FORBIDDEN", "Você não possui permissão para esta ação.");
    return false;
  }
  return true;
}
function safeHttpsUrl(raw: string): string {
  const url = new URL(raw);
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    isIP(host) !== 0 ||
    !host.includes(".") ||
    host.endsWith(".local") ||
    host.endsWith(".localhost") ||
    host.endsWith(".internal") ||
    host.endsWith(".test") ||
    host.endsWith(".example")
  )
    throw new Error(
      "A URL de imagem/produto precisa usar HTTPS público, sem credenciais.",
    );
  return url.toString();
}
function actionId(request: FastifyRequest) {
  const raw = request.headers["idempotency-key"];
  const value = typeof raw === "string" ? raw.trim() : "";
  return idempotency.test(value) ? value : null;
}
async function ownedInstance(tenant: string, name: string) {
  const claim = await prisma.connectInstanceClaim.findUnique({
    where: { name },
  });
  if (!claim || claim.tenantId !== tenant) return null;
  const instance = await prisma.connectApiInstance.findFirst({
    where: { tenantId: tenant, name, present: true },
    select: { id: true, name: true, tokenEncrypted: true, integration: true },
  });
  if (!instance?.tokenEncrypted) return null;
  const global = globalConnectSettings();
  if (!global) return { missingGlobal: true as const };
  return {
    missingGlobal: false as const,
    token: decryptSecret(instance.tokenEncrypted),
    baseUrl: global.baseUrl,
    instance,
  };
}
async function publish(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  name: string,
  kind: "STATUS" | "CATALOG_SHARE",
  payload: Record<string, unknown>,
  remotePath: string,
) {
  if (!allow(request, reply, readableRoles)) return;
  const key = actionId(request);
  if (!key)
    return fail(
      reply,
      400,
      "IDEMPOTENCY_KEY_REQUIRED",
      "Informe uma chave de idempotência para evitar envios duplicados.",
    );
  const tenant = request.principal!.tenantId;
  const connection = await ownedInstance(tenant, name);
  if (!connection)
    return fail(
      reply,
      404,
      "INSTANCE_NOT_FOUND",
      "Instância indisponível neste espaço.",
    );
  if (connection.missingGlobal)
    return fail(
      reply,
      409,
      "CONNECT_UNAVAILABLE",
      "Configure a Connect|API no servidor.",
    );
  const payloadHash = createHash("sha256")
    .update(JSON.stringify({ name, kind, payload }))
    .digest("hex");
  let action;
  try {
    action = await prisma.channelAction.create({
      data: {
        tenantId: tenant,
        remoteInstance: name,
        kind,
        requestId: key,
        payloadHash,
      },
    });
  } catch (cause) {
    if (
      cause instanceof Prisma.PrismaClientKnownRequestError &&
      cause.code === "P2002"
    ) {
      const prior = await prisma.channelAction.findUnique({
        where: { tenantId_requestId: { tenantId: tenant, requestId: key } },
      });
      if (
        !prior ||
        prior.payloadHash !== payloadHash ||
        prior.kind !== kind ||
        prior.remoteInstance !== name
      )
        return fail(
          reply,
          409,
          "IDEMPOTENCY_KEY_REUSED",
          "A chave já foi utilizada com outros dados.",
        );
      return reply.send({
        action: { id: prior.id, kind: prior.kind, status: prior.status },
        duplicateRequest: true,
      });
    }
    throw cause;
  }
  try {
    await connectApiRequest<unknown>({
      baseUrl: connection.baseUrl,
      apiKey: connection.token,
      method: "POST",
      path: remotePath,
      body: payload,
      timeoutMs: 20000,
    });
    const updated = await prisma.channelAction.update({
      where: { id: action.id },
      data: { status: "SENT", sentAt: new Date() },
    });
    await audit({
      tenantId: tenant,
      actorUserId: request.principal?.userId,
      action:
        kind === "STATUS" ? "whatsapp.status.sent" : "whatsapp.catalog.shared",
      resourceType: "channel-action",
      resourceId: action.id,
      metadata: { remoteInstance: name },
    }).catch(() =>
      request.log.warn(
        { requestId: request.id },
        "Falha na auditoria de publicação.",
      ),
    );
    return reply
      .code(201)
      .send({ action: { id: updated.id, kind, status: "SENT" } });
  } catch (cause) {
    const remoteCode =
      cause instanceof ConnectApiError ? cause.statusCode : undefined;
    const unknown = !remoteCode || remoteCode >= 500 || remoteCode === 408;
    const status = unknown ? "UNKNOWN" : "FAILED";
    await prisma.channelAction.update({
      where: { id: action.id },
      data: {
        status,
        errorCode: unknown ? "DELIVERY_UNCERTAIN" : "CONNECT_REJECTED",
      },
    });
    return reply.code(unknown ? 202 : 502).send({
      action: { id: action.id, kind, status },
      message: unknown
        ? "O envio pode ter ocorrido. Consulte a instância antes de tentar novamente."
        : "A Connect|API rejeitou a publicação. Verifique o estado da instância.",
    });
  }
}

export async function registerWhatsAppExtensions(app: FastifyInstance) {
  app.get(
    "/whatsapp/channel-actions",
    { preHandler: authenticated() },
    async (request, reply) => {
      if (!allow(request, reply, readableRoles)) return;
      const events = await prisma.channelAction.findMany({
        where: { tenantId: request.principal!.tenantId },
        orderBy: { createdAt: "desc" },
        take: 100,
        select: {
          id: true,
          remoteInstance: true,
          kind: true,
          status: true,
          errorCode: true,
          createdAt: true,
          sentAt: true,
        },
      });
      return { data: events };
    },
  );
  app.get(
    "/whatsapp/instances/:name/statuses",
    { preHandler: authenticated() },
    async (request, reply) => {
      if (!allow(request, reply, readableRoles)) return;
      const params = z.object({ name: remoteName }).safeParse(request.params);
      const query = z
        .object({ page: z.coerce.number().int().min(1).max(100).default(1) })
        .safeParse(request.query);
      if (!params.success || !query.success)
        return fail(
          reply,
          400,
          "INVALID_QUERY",
          "Instância ou paginação inválida.",
        );
      const connection = await ownedInstance(
        request.principal!.tenantId,
        params.data.name,
      );
      if (!connection)
        return fail(
          reply,
          404,
          "INSTANCE_NOT_FOUND",
          "Instância indisponível.",
        );
      if (connection.missingGlobal)
        return fail(
          reply,
          409,
          "CONNECT_UNAVAILABLE",
          "Configure a Connect|API no servidor.",
        );
      try {
        const response = await connectApiRequest<unknown>({
          baseUrl: connection.baseUrl,
          apiKey: connection.token,
          path: `chat/findPublishedStatuses/${encodeURIComponent(params.data.name)}?page=${query.data.page}&offset=50`,
        });
        return { data: sanitizeConnectApiResponse(response) };
      } catch {
        return fail(
          reply,
          502,
          "STATUS_LIST_FAILED",
          "Não foi possível consultar os status publicados.",
        );
      }
    },
  );
  app.post(
    "/whatsapp/instances/:name/statuses",
    {
      preHandler: authenticated(),
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
      bodyLimit: 24 * 1024,
    },
    async (request, reply) => {
      const params = z.object({ name: remoteName }).safeParse(request.params);
      const body = statusSchema.safeParse(request.body);
      if (!params.success || !body.success)
        return fail(
          reply,
          400,
          "INVALID_STATUS",
          "Revise tipo, conteúdo e autorização dos destinatários.",
        );
      if (!body.data.allContacts && !body.data.statusJidList?.length)
        return fail(
          reply,
          400,
          "RECIPIENT_REQUIRED",
          "Selecione destinatários ou autorize explicitamente todos os contatos.",
        );
      if (body.data.type === "image") {
        try {
          safeHttpsUrl(body.data.content);
        } catch {
          return fail(
            reply,
            400,
            "INVALID_MEDIA_URL",
            "Use uma imagem HTTPS pública e confiável.",
          );
        }
      }
      const { confirmed: _confirmed, ...payload } = body.data;
      return publish(
        app,
        request,
        reply,
        params.data.name,
        "STATUS",
        payload,
        `message/sendStatus/${encodeURIComponent(params.data.name)}`,
      );
    },
  );
  app.get(
    "/whatsapp/instances/:name/catalog",
    { preHandler: authenticated() },
    async (request, reply) => {
      if (!allow(request, reply, readableRoles)) return;
      const params = z.object({ name: remoteName }).safeParse(request.params);
      const query = z
        .object({
          limit: z.coerce.number().int().min(1).max(30).default(10),
          cursor: z.string().max(1024).optional(),
        })
        .safeParse(request.query);
      if (!params.success || !query.success)
        return fail(
          reply,
          400,
          "INVALID_QUERY",
          "Instância ou filtros inválidos.",
        );
      const connection = await ownedInstance(
        request.principal!.tenantId,
        params.data.name,
      );
      if (!connection)
        return fail(
          reply,
          404,
          "INSTANCE_NOT_FOUND",
          "Instância não pertence a este espaço.",
        );
      if (connection.missingGlobal)
        return fail(
          reply,
          409,
          "CONNECT_UNAVAILABLE",
          "Configure a Connect|API no servidor.",
        );
      try {
        const data = await connectApiRequest<unknown>({
          baseUrl: connection.baseUrl,
          apiKey: connection.token,
          method: "POST",
          path: `business/getCatalog/${encodeURIComponent(params.data.name)}`,
          body: {
            limit: query.data.limit,
            maxPages: 1,
            ...(query.data.cursor ? { cursor: query.data.cursor } : {}),
          },
          timeoutMs: 15000,
        });
        return { data: sanitizeConnectApiResponse(data), readonly: true };
      } catch {
        return fail(
          reply,
          502,
          "CATALOG_UNAVAILABLE",
          "A instância não disponibilizou consulta ao catálogo comercial.",
        );
      }
    },
  );
  app.post(
    "/whatsapp/instances/:name/catalog/share",
    {
      preHandler: authenticated(),
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const params = z.object({ name: remoteName }).safeParse(request.params);
      const body = shareSchema.safeParse(request.body);
      if (!params.success || !body.success)
        return fail(
          reply,
          400,
          "INVALID_SHARE",
          "Revise produto, URL e número.",
        );
      let url;
      try {
        url = safeHttpsUrl(body.data.productUrl);
      } catch {
        return fail(
          reply,
          400,
          "INVALID_PRODUCT_URL",
          "Informe um link HTTPS público válido.",
        );
      }
      const text = [body.data.title, body.data.description, url]
        .filter(Boolean)
        .join("\n");
      if (text.length > 4096)
        return fail(
          reply,
          400,
          "MESSAGE_TOO_LONG",
          "Mensagem excede o limite do WhatsApp.",
        );
      return publish(
        app,
        request,
        reply,
        params.data.name,
        "CATALOG_SHARE",
        sendWhatsAppTextPayload(body.data.number, text),
        connectSendTextPath(params.data.name),
      );
    },
  );
}
