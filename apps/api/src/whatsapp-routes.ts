import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Prisma, TenantRole, WhatsAppPublicationStatus } from "@prisma/client";
import { z } from "zod";
import {
  decryptSecret,
  encryptSecret,
  randomToken,
} from "@argws/scout-shared/crypto";
import { audit } from "./audit.ts";
import { prisma } from "./db.ts";
import { authenticated, hasRole, isManagerUser } from "./auth.ts";
import {
  connectApiRequest,
  connectInstancePath,
  connectSendTextPath,
  ConnectApiError,
  createWhatsAppInstancePayload,
  isWhatsAppIntegration,
  normalizeConnectBaseUrl,
  normalizeConnectInstances,
  sanitizeConnectApiResponse,
  sendWhatsAppTextPayload,
} from "./connect-api.ts";

const adminRoles = [TenantRole.OWNER, TenantRole.ADMIN];
const publisherRoles = [...adminRoles, TenantRole.OPERATOR];
const nameSchema = z
  .string()
  .trim()
  .min(2)
  .max(120)
  .regex(
    /^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u,
    "Use letras, números, espaço, ponto, hífen ou sublinhado no nome da instância.",
  );
const configSchema = z.object({
  baseUrl: z.string().trim().min(8).max(2048),
  apiKey: z.string().trim().max(4096).optional().default(""),
});
const createSchema = z.object({ name: nameSchema });
const importSchema = z.object({
  name: nameSchema,
  token: z.string().trim().min(8).max(4096),
});
const defaultSchema = z.object({ instanceName: nameSchema.nullable() });
const publishSchema = z.object({
  jobId: z.string().uuid(),
  instanceName: nameSchema,
  number: z.string().trim().min(8).max(24),
  text: z.string().trim().min(1).max(4096),
});

function fail(
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
) {
  return reply.code(status).send({ error: { code, message } });
}

function tenantId(request: FastifyRequest): string {
  return request.principal!.tenantId;
}

async function requireAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<boolean> {
  if (!isManagerUser(request) || !hasRole(request, ...adminRoles)) {
    fail(reply, 403, "FORBIDDEN", "Esta ação exige perfil de administração.");
    return false;
  }
  return true;
}

async function requirePublisher(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<boolean> {
  if (!isManagerUser(request) || !hasRole(request, ...publisherRoles)) {
    fail(reply, 403, "FORBIDDEN", "Esta ação exige perfil de operação.");
    return false;
  }
  return true;
}

function connectError(error: unknown): {
  status: number;
  code: string;
  message: string;
} {
  if (error instanceof ConnectApiError)
    return {
      status: error.statusCode ? 502 : 400,
      code: error.statusCode ? "CONNECT_API_REJECTED" : "CONNECT_API_INVALID",
      message: error.statusCode
        ? `A Connect API respondeu HTTP ${error.statusCode}.`
        : error.message,
    };
  return {
    status: 502,
    code: "CONNECT_API_UNAVAILABLE",
    message:
      "Não foi possível acessar a Connect API. Confira a URL e a conectividade.",
  };
}

async function credentials(tenant: string) {
  const config = await prisma.connectApiConfig.findUnique({
    where: { tenantId: tenant },
  });
  if (!config) return null;
  return {
    config,
    apiKey: decryptSecret(config.apiKeyEncrypted),
  };
}

function wireStatus(status: WhatsAppPublicationStatus) {
  return {
    PENDING: "PENDING",
    SENDING: "SENDING",
    SENT: "SENT",
    FAILED: "FAILED",
    UNKNOWN: "UNKNOWN",
  }[status];
}

async function storeRemoteInstances(tenant: string, payload: unknown) {
  const remote = normalizeConnectInstances(payload).filter((instance) =>
    isWhatsAppIntegration(instance.integration),
  );
  const seen = new Set(remote.map((instance) => instance.name));
  if (seen.size) {
    await prisma.connectApiInstance.updateMany({
      where: { tenantId: tenant, present: true, name: { notIn: [...seen] } },
      data: { present: false },
    });
  } else {
    await prisma.connectApiInstance.updateMany({
      where: { tenantId: tenant, present: true },
      data: { present: false },
    });
  }
  for (const instance of remote) {
    const tokenEncrypted = instance.token
      ? encryptSecret(instance.token)
      : undefined;
    await prisma.connectApiInstance.upsert({
      where: {
        tenantId_name: { tenantId: tenant, name: instance.name },
      },
      create: {
        tenantId: tenant,
        name: instance.name,
        integration: instance.integration,
        ...(tokenEncrypted ? { tokenEncrypted } : {}),
        connectionState: instance.connectionState,
        number: instance.number,
        profileName: instance.profileName,
        present: true,
      },
      update: {
        integration: instance.integration,
        ...(tokenEncrypted ? { tokenEncrypted } : {}),
        ...(instance.connectionState !== undefined
          ? { connectionState: instance.connectionState }
          : {}),
        ...(instance.number !== undefined ? { number: instance.number } : {}),
        ...(instance.profileName !== undefined
          ? { profileName: instance.profileName }
          : {}),
        present: true,
      },
    });
  }
  const config = await prisma.connectApiConfig.findUnique({
    where: { tenantId: tenant },
    select: { defaultInstanceName: true },
  });
  if (config?.defaultInstanceName && !seen.has(config.defaultInstanceName))
    await prisma.connectApiConfig.update({
      where: { tenantId: tenant },
      data: { defaultInstanceName: null },
    });
  return prisma.connectApiInstance.findMany({
    where: { tenantId: tenant, present: true },
    orderBy: { name: "asc" },
  });
}

async function syncInstances(tenant: string, baseUrl: string, apiKey: string) {
  const payload = await connectApiRequest<unknown>({
    baseUrl,
    apiKey,
    path: "instance/fetchInstances",
  });
  return storeRemoteInstances(tenant, payload);
}

function publicInstance(instance: {
  id: string;
  name: string;
  integration: string;
  connectionState: string | null;
  number: string | null;
  profileName: string | null;
  present: boolean;
  tokenEncrypted: string | null;
  updatedAt: Date;
}) {
  return {
    id: instance.id,
    name: instance.name,
    integration: instance.integration,
    connectionState: instance.connectionState,
    number: instance.number,
    profileName: instance.profileName,
    present: instance.present,
    usable: Boolean(instance.tokenEncrypted && instance.present),
    updatedAt: instance.updatedAt,
  };
}

async function loadRemoteInstance(tenant: string, name: string) {
  return prisma.connectApiInstance.findFirst({
    where: { tenantId: tenant, name, present: true },
  });
}

function normalizedNumber(raw: string): string | null {
  if (!/^[+\d\s().-]+$/.test(raw)) return null;
  const digits = raw.replace(/\D/g, "");
  return /^[1-9]\d{7,14}$/.test(digits) ? digits : null;
}

function idempotencyKey(request: FastifyRequest): string | null {
  const value = request.headers["idempotency-key"];
  const key = typeof value === "string" ? value.trim() : "";
  return /^[A-Za-z0-9._:-]{8,80}$/.test(key) ? key : null;
}

export async function registerWhatsAppRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.get(
    "/whatsapp",
    { preHandler: authenticated() },
    async (request, reply) => {
      if (!isManagerUser(request))
        return fail(reply, 403, "FORBIDDEN", "Use uma sessão do Manager.");
      const tenant = tenantId(request);
      const [config, instances] = await Promise.all([
        prisma.connectApiConfig.findUnique({ where: { tenantId: tenant } }),
        prisma.connectApiInstance.findMany({
          where: { tenantId: tenant, present: true },
          orderBy: { name: "asc" },
        }),
      ]);
      return {
        configured: Boolean(config),
        baseUrl: config?.baseUrl ?? "",
        defaultInstanceName: config?.defaultInstanceName ?? null,
        instances: instances.map(publicInstance),
        canManage: hasRole(request, ...adminRoles),
        canPublish: hasRole(request, ...publisherRoles),
      };
    },
  );

  app.put(
    "/whatsapp/config",
    { preHandler: authenticated() },
    async (request, reply) => {
      if (!(await requireAdmin(request, reply))) return;
      const body = configSchema.safeParse(request.body);
      if (!body.success)
        return fail(
          reply,
          400,
          "VALIDATION_ERROR",
          "Revise a URL e a chave informadas.",
        );
      let baseUrl: string;
      try {
        baseUrl = normalizeConnectBaseUrl(body.data.baseUrl);
      } catch (error) {
        const info = connectError(error);
        return fail(reply, info.status, info.code, info.message);
      }
      const tenant = tenantId(request);
      const current = await prisma.connectApiConfig.findUnique({
        where: { tenantId: tenant },
      });
      const apiKey =
        body.data.apiKey ||
        (current ? decryptSecret(current.apiKeyEncrypted) : "");
      if (!apiKey)
        return fail(
          reply,
          400,
          "API_KEY_REQUIRED",
          "Informe a chave administrativa da Connect API.",
        );
      try {
        const payload = await connectApiRequest<unknown>({
          baseUrl,
          apiKey,
          path: "instance/fetchInstances",
        });
        const updated = await prisma.connectApiConfig.upsert({
          where: { tenantId: tenant },
          create: {
            tenantId: tenant,
            baseUrl,
            apiKeyEncrypted: encryptSecret(apiKey),
          },
          update: {
            baseUrl,
            apiKeyEncrypted: encryptSecret(apiKey),
            ...(baseUrl !== current?.baseUrl
              ? { defaultInstanceName: null }
              : {}),
          },
        });
        const instances = await storeRemoteInstances(tenant, payload);
        await audit({
          tenantId: tenant,
          actorUserId: request.principal?.userId,
          action: "whatsapp.connect_api.configured",
          resourceType: "connect-api",
          resourceId: tenant,
          metadata: { host: new URL(updated.baseUrl).host },
        });
        return {
          configured: true,
          baseUrl: updated.baseUrl,
          defaultInstanceName: updated.defaultInstanceName,
          instances: instances.map(publicInstance),
        };
      } catch (error) {
        const info = connectError(error);
        return fail(reply, info.status, info.code, info.message);
      }
    },
  );

  app.post(
    "/whatsapp/sync",
    { preHandler: authenticated() },
    async (request, reply) => {
      if (!(await requireAdmin(request, reply))) return;
      const auth = await credentials(tenantId(request));
      if (!auth)
        return fail(
          reply,
          409,
          "CONNECT_API_NOT_CONFIGURED",
          "Configure primeiro a Connect API.",
        );
      try {
        const instances = await syncInstances(
          tenantId(request),
          auth.config.baseUrl,
          auth.apiKey,
        );
        return { data: instances.map(publicInstance) };
      } catch (error) {
        const info = connectError(error);
        return fail(reply, info.status, info.code, info.message);
      }
    },
  );

  app.post(
    "/whatsapp/instances",
    { preHandler: authenticated() },
    async (request, reply) => {
      if (!(await requireAdmin(request, reply))) return;
      const body = createSchema.safeParse(request.body);
      if (!body.success)
        return fail(
          reply,
          400,
          "VALIDATION_ERROR",
          "Informe um nome válido para a instância.",
        );
      const tenant = tenantId(request);
      const auth = await credentials(tenant);
      if (!auth)
        return fail(
          reply,
          409,
          "CONNECT_API_NOT_CONFIGURED",
          "Configure primeiro a Connect API.",
        );
      const existing = await prisma.connectApiInstance.findUnique({
        where: {
          tenantId_name: { tenantId: tenant, name: body.data.name },
        },
      });
      if (existing?.present)
        return fail(
          reply,
          409,
          "INSTANCE_ALREADY_REGISTERED",
          "Este nome já está vinculado à organização. Sincronize ou use outro nome.",
        );
      const token = randomToken(36);
      const reservation = existing
        ? await prisma.connectApiInstance.update({
            where: { id: existing.id },
            data: {
              integration: "WHATSAPP-BAILEYS",
              tokenEncrypted: encryptSecret(token),
              connectionState: "connecting",
              present: false,
            },
          })
        : await prisma.connectApiInstance.create({
            data: {
              tenantId: tenant,
              name: body.data.name,
              integration: "WHATSAPP-BAILEYS",
              tokenEncrypted: encryptSecret(token),
              connectionState: "connecting",
              present: false,
            },
          });
      try {
        await connectApiRequest({
          baseUrl: auth.config.baseUrl,
          apiKey: auth.apiKey,
          path: "instance/create",
          method: "POST",
          body: createWhatsAppInstancePayload(body.data.name, token),
        });
      } catch (error) {
        const mayHaveCreated = !(
          error instanceof ConnectApiError &&
          error.statusCode !== undefined &&
          error.statusCode < 500
        );
        if (!mayHaveCreated)
          await prisma.connectApiInstance.delete({
            where: { id: reservation.id },
          });
        else
          await prisma.connectApiInstance.update({
            where: { id: reservation.id },
            data: { connectionState: "unknown" },
          });
        const info = connectError(error);
        if (mayHaveCreated)
          return fail(
            reply,
            502,
            "CREATE_OUTCOME_UNKNOWN",
            "A Connect API não confirmou a criação. Sincronize as instâncias antes de tentar novamente.",
          );
        return fail(reply, info.status, info.code, info.message);
      }
      const instance = await prisma.connectApiInstance.update({
        where: { id: reservation.id },
        data: { present: true },
      });
      await audit({
        tenantId: tenant,
        actorUserId: request.principal?.userId,
        action: "whatsapp.instance.created",
        resourceType: "whatsapp-instance",
        resourceId: instance.id,
        metadata: { name: instance.name },
      });
      return reply.code(201).send({ instance: publicInstance(instance) });
    },
  );

  app.post(
    "/whatsapp/instances/import",
    { preHandler: authenticated() },
    async (request, reply) => {
      if (!(await requireAdmin(request, reply))) return;
      const body = importSchema.safeParse(request.body);
      if (!body.success)
        return fail(
          reply,
          400,
          "VALIDATION_ERROR",
          "Informe o nome e o token da instância.",
        );
      const tenant = tenantId(request);
      const auth = await credentials(tenant);
      if (!auth)
        return fail(
          reply,
          409,
          "CONNECT_API_NOT_CONFIGURED",
          "Configure primeiro a Connect API.",
        );
      try {
        const payload = await connectApiRequest<unknown>({
          baseUrl: auth.config.baseUrl,
          apiKey: body.data.token,
          path: `instance/fetchInstances?instanceName=${encodeURIComponent(body.data.name)}`,
        });
        const remote = normalizeConnectInstances(payload).find(
          (instance) => instance.name === body.data.name,
        );
        if (!remote)
          return fail(
            reply,
            404,
            "INSTANCE_NOT_FOUND",
            "A instância não foi encontrada com esse token.",
          );
        if (!isWhatsAppIntegration(remote.integration))
          return fail(
            reply,
            400,
            "UNSUPPORTED_INTEGRATION",
            "Esta integração não é um canal WhatsApp.",
          );
        const instance = await prisma.connectApiInstance.upsert({
          where: {
            tenantId_name: { tenantId: tenant, name: remote.name },
          },
          create: {
            tenantId: tenant,
            name: remote.name,
            integration: remote.integration,
            tokenEncrypted: encryptSecret(body.data.token),
            connectionState: remote.connectionState,
            number: remote.number,
            profileName: remote.profileName,
            present: true,
          },
          update: {
            integration: remote.integration,
            tokenEncrypted: encryptSecret(body.data.token),
            connectionState: remote.connectionState,
            number: remote.number,
            profileName: remote.profileName,
            present: true,
          },
        });
        await audit({
          tenantId: tenant,
          actorUserId: request.principal?.userId,
          action: "whatsapp.instance.imported",
          resourceType: "whatsapp-instance",
          resourceId: instance.id,
          metadata: { name: instance.name },
        });
        return reply.code(201).send({ instance: publicInstance(instance) });
      } catch (error) {
        const info = connectError(error);
        return fail(reply, info.status, info.code, info.message);
      }
    },
  );

  app.put(
    "/whatsapp/default",
    { preHandler: authenticated() },
    async (request, reply) => {
      if (!(await requireAdmin(request, reply))) return;
      const body = defaultSchema.safeParse(request.body);
      if (!body.success)
        return fail(
          reply,
          400,
          "VALIDATION_ERROR",
          "Instância padrão inválida.",
        );
      const tenant = tenantId(request);
      if (body.data.instanceName) {
        const instance = await loadRemoteInstance(
          tenant,
          body.data.instanceName,
        );
        if (!instance || !instance.tokenEncrypted)
          return fail(
            reply,
            404,
            "INSTANCE_NOT_USABLE",
            "A instância não está vinculada e pronta para uso.",
          );
      }
      const updated = await prisma.connectApiConfig
        .update({
          where: { tenantId: tenant },
          data: { defaultInstanceName: body.data.instanceName },
        })
        .catch(() => null);
      if (!updated)
        return fail(
          reply,
          409,
          "CONNECT_API_NOT_CONFIGURED",
          "Configure primeiro a Connect API.",
        );
      await audit({
        tenantId: tenant,
        actorUserId: request.principal?.userId,
        action: "whatsapp.instance.default_changed",
        resourceType: "whatsapp-instance",
        resourceId: body.data.instanceName ?? undefined,
      });
      return { defaultInstanceName: updated.defaultInstanceName };
    },
  );

  app.post(
    "/whatsapp/instances/:name/:action",
    { preHandler: authenticated() },
    async (request, reply) => {
      if (!(await requireAdmin(request, reply))) return;
      const { name, action } = request.params as {
        name: string;
        action: string;
      };
      const parsedName = nameSchema.safeParse(decodeURIComponent(name));
      if (!parsedName.success)
        return fail(
          reply,
          400,
          "INSTANCE_NAME_INVALID",
          "Nome de instância inválido.",
        );
      if (!["connect", "status", "restart", "logout"].includes(action))
        return fail(
          reply,
          404,
          "ACTION_NOT_FOUND",
          "Ação de instância não encontrada.",
        );
      const tenant = tenantId(request);
      const instance = await loadRemoteInstance(tenant, parsedName.data);
      if (!instance || !instance.tokenEncrypted)
        return fail(
          reply,
          404,
          "INSTANCE_NOT_USABLE",
          "A instância não está vinculada à Scout.",
        );
      const auth = await credentials(tenant);
      if (!auth)
        return fail(
          reply,
          409,
          "CONNECT_API_NOT_CONFIGURED",
          "Configure primeiro a Connect API.",
        );
      const token = decryptSecret(instance.tokenEncrypted);
      const method =
        action === "restart" ? "POST" : action === "logout" ? "DELETE" : "GET";
      const apiAction =
        action === "status"
          ? "connectionState"
          : action === "logout"
            ? "logout"
            : action;
      try {
        const result = await connectApiRequest<unknown>({
          baseUrl: auth.config.baseUrl,
          apiKey: token,
          method,
          path: connectInstancePath(instance.name, apiAction),
        });
        if (action === "status") {
          const root =
            result && typeof result === "object"
              ? (result as Record<string, unknown>)
              : {};
          const detail =
            root.instance && typeof root.instance === "object"
              ? (root.instance as Record<string, unknown>)
              : root;
          const state =
            typeof detail.state === "string" ? detail.state : "unknown";
          const updated = await prisma.connectApiInstance.update({
            where: { id: instance.id },
            data: { connectionState: state },
          });
          return { instance: publicInstance(updated), state };
        }
        if (action === "logout")
          await prisma.connectApiInstance.update({
            where: { id: instance.id },
            data: { connectionState: "close" },
          });
        await audit({
          tenantId: tenant,
          actorUserId: request.principal?.userId,
          action: `whatsapp.instance.${action}`,
          resourceType: "whatsapp-instance",
          resourceId: instance.id,
          metadata: { name: instance.name },
        });
        return { result: sanitizeConnectApiResponse(result) };
      } catch (error) {
        const info = connectError(error);
        return fail(reply, info.status, info.code, info.message);
      }
    },
  );

  app.delete(
    "/whatsapp/instances/:name",
    { preHandler: authenticated() },
    async (request, reply) => {
      if (!(await requireAdmin(request, reply))) return;
      const { name } = request.params as { name: string };
      const parsedName = nameSchema.safeParse(decodeURIComponent(name));
      if (!parsedName.success)
        return fail(
          reply,
          400,
          "INSTANCE_NAME_INVALID",
          "Nome de instância inválido.",
        );
      const tenant = tenantId(request);
      const auth = await credentials(tenant);
      const instance = await loadRemoteInstance(tenant, parsedName.data);
      if (!auth || !instance)
        return fail(
          reply,
          404,
          "INSTANCE_NOT_FOUND",
          "Instância não encontrada nesta organização.",
        );
      try {
        await connectApiRequest({
          baseUrl: auth.config.baseUrl,
          apiKey: auth.apiKey,
          method: "DELETE",
          path: connectInstancePath(instance.name, "delete"),
        });
        await prisma.$transaction([
          prisma.connectApiInstance.update({
            where: { id: instance.id },
            data: {
              present: false,
              tokenEncrypted: null,
              connectionState: "deleted",
            },
          }),
          prisma.connectApiConfig.updateMany({
            where: { tenantId: tenant, defaultInstanceName: instance.name },
            data: { defaultInstanceName: null },
          }),
        ]);
        await audit({
          tenantId: tenant,
          actorUserId: request.principal?.userId,
          action: "whatsapp.instance.deleted",
          resourceType: "whatsapp-instance",
          resourceId: instance.id,
          metadata: { name: instance.name },
        });
        return reply.code(204).send();
      } catch (error) {
        const info = connectError(error);
        return fail(reply, info.status, info.code, info.message);
      }
    },
  );

  app.get(
    "/whatsapp/publications",
    { preHandler: authenticated() },
    async (request, reply) => {
      if (!isManagerUser(request))
        return fail(reply, 403, "FORBIDDEN", "Use uma sessão do Manager.");
      await prisma.whatsAppPublication.updateMany({
        where: {
          tenantId: tenantId(request),
          status: {
            in: [
              WhatsAppPublicationStatus.PENDING,
              WhatsAppPublicationStatus.SENDING,
            ],
          },
          updatedAt: { lt: new Date(Date.now() - 60_000) },
        },
        data: {
          status: WhatsAppPublicationStatus.UNKNOWN,
          errorCode: "DELIVERY_UNCERTAIN",
        },
      });
      const rows = await prisma.whatsAppPublication.findMany({
        where: { tenantId: tenantId(request) },
        orderBy: { createdAt: "desc" },
        take: 50,
        include: {
          job: { select: { id: true, source: { select: { name: true } } } },
        },
      });
      return {
        data: rows.map((row) => ({
          id: row.id,
          jobId: row.jobId,
          sourceName: row.job?.source.name ?? null,
          instanceName: row.instanceName,
          recipientLast4: decryptSecret(row.recipientEncrypted).slice(-4),
          messageLength: decryptSecret(row.messageEncrypted).length,
          status: wireStatus(row.status),
          statusCode: row.statusCode,
          errorCode: row.errorCode,
          createdAt: row.createdAt,
          sentAt: row.sentAt,
        })),
      };
    },
  );

  app.post(
    "/whatsapp/publications",
    {
      preHandler: authenticated(),
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      if (!(await requirePublisher(request, reply))) return;
      const body = publishSchema.safeParse(request.body);
      if (!body.success)
        return fail(
          reply,
          400,
          "VALIDATION_ERROR",
          "Revise o número e a mensagem antes de enviar.",
        );
      const requestId = idempotencyKey(request);
      if (!requestId)
        return fail(
          reply,
          400,
          "IDEMPOTENCY_KEY_REQUIRED",
          "O envio precisa de uma chave de idempotência válida.",
        );
      const number = normalizedNumber(body.data.number);
      if (!number)
        return fail(
          reply,
          400,
          "WHATSAPP_NUMBER_INVALID",
          "Use o número com DDI, somente dígitos ou formato internacional.",
        );

      const tenant = tenantId(request);
      const job = await prisma.job.findFirst({
        where: { id: body.data.jobId, tenantId: tenant, status: "SUCCEEDED" },
        include: { source: { select: { name: true } } },
      });
      if (!job)
        return fail(
          reply,
          404,
          "COMPLETED_JOB_NOT_FOUND",
          "Selecione uma coleta concluída desta organização.",
        );
      const instance = await loadRemoteInstance(tenant, body.data.instanceName);
      if (!instance || !instance.tokenEncrypted)
        return fail(
          reply,
          409,
          "INSTANCE_NOT_USABLE",
          "Selecione uma instância WhatsApp vinculada à Connect API.",
        );
      const auth = await credentials(tenant);
      if (!auth)
        return fail(
          reply,
          409,
          "CONNECT_API_NOT_CONFIGURED",
          "Configure primeiro a Connect API.",
        );

      const recipientEncrypted = encryptSecret(number);
      const messageEncrypted = encryptSecret(body.data.text);
      let publication;
      try {
        publication = await prisma.whatsAppPublication.create({
          data: {
            tenantId: tenant,
            jobId: job.id,
            createdById: request.principal?.userId,
            requestId,
            instanceName: instance.name,
            recipientEncrypted,
            messageEncrypted,
          },
        });
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002"
        ) {
          const existing = await prisma.whatsAppPublication.findUnique({
            where: { tenantId_requestId: { tenantId: tenant, requestId } },
          });
          if (
            existing &&
            decryptSecret(existing.recipientEncrypted) === number &&
            decryptSecret(existing.messageEncrypted) === body.data.text &&
            existing.instanceName === instance.name &&
            existing.jobId === job.id
          )
            return reply.code(200).send({
              publication: {
                id: existing.id,
                status: wireStatus(existing.status),
                createdAt: existing.createdAt,
                sentAt: existing.sentAt,
                errorCode: existing.errorCode,
              },
              duplicateRequest: true,
            });
          return fail(
            reply,
            409,
            "IDEMPOTENCY_KEY_REUSED",
            "Esta chave de envio já foi usada com outro conteúdo.",
          );
        }
        throw error;
      }

      await prisma.whatsAppPublication.update({
        where: { id: publication.id },
        data: { status: WhatsAppPublicationStatus.SENDING },
      });
      let status: WhatsAppPublicationStatus = WhatsAppPublicationStatus.UNKNOWN;
      let statusCode: number | undefined;
      let errorCode: string | undefined;
      try {
        await connectApiRequest({
          baseUrl: auth.config.baseUrl,
          apiKey: decryptSecret(instance.tokenEncrypted),
          method: "POST",
          path: connectSendTextPath(instance.name),
          body: sendWhatsAppTextPayload(number, body.data.text),
          timeoutMs: 15000,
        });
        status = WhatsAppPublicationStatus.SENT;
      } catch (error) {
        if (error instanceof ConnectApiError && error.statusCode) {
          statusCode = error.statusCode;
          status =
            error.statusCode >= 500 || error.statusCode === 408
              ? WhatsAppPublicationStatus.UNKNOWN
              : WhatsAppPublicationStatus.FAILED;
        }
        errorCode =
          status === WhatsAppPublicationStatus.UNKNOWN
            ? "DELIVERY_UNCERTAIN"
            : "CONNECT_API_REJECTED";
      }
      publication = await prisma.whatsAppPublication.update({
        where: { id: publication.id },
        data: {
          status,
          statusCode,
          errorCode,
          ...(status === WhatsAppPublicationStatus.SENT
            ? { sentAt: new Date() }
            : {}),
        },
      });
      await audit({
        tenantId: tenant,
        actorUserId: request.principal?.userId,
        action: `whatsapp.publication.${status.toLowerCase()}`,
        resourceType: "whatsapp-publication",
        resourceId: publication.id,
        metadata: {
          jobId: job.id,
          instanceName: instance.name,
          statusCode: statusCode ?? null,
        },
      });
      return reply.code(201).send({
        publication: {
          id: publication.id,
          status: wireStatus(publication.status),
          createdAt: publication.createdAt,
          sentAt: publication.sentAt,
          errorCode: publication.errorCode,
          statusCode: publication.statusCode,
        },
        ...(status === WhatsAppPublicationStatus.UNKNOWN
          ? {
              message:
                "A Connect API não confirmou o resultado. Confira o WhatsApp antes de tentar novamente.",
            }
          : status === WhatsAppPublicationStatus.FAILED
            ? {
                message: `A Connect API rejeitou o envio (HTTP ${statusCode}).`,
              }
            : {}),
      });
    },
  );
}
