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
  connectPairingPath,
  connectSendTextPath,
  ConnectApiError,
  createWhatsAppInstancePayload,
  isWhatsAppIntegration,
  normalizeConnectInstances,
  sanitizeConnectApiResponse,
  sendWhatsAppTextPayload,
} from "./connect-api.ts";
import { globalConnectSettings, remoteInstanceName } from "./global-connect.ts";
import { deleteRemoteInstance } from "./connect-deletion.ts";

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
const createSchema = z.object({
  name: nameSchema,
  provider: z.enum(["WHATSAPP-BAILEYS", "WHATSAPP-ZAPO"]).default("WHATSAPP-BAILEYS"),
});
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

function credentials() {
  // One Connect|API integration for the entire Scout installation.
  // Tenant administrators do not receive, read or change this secret.
  return globalConnectSettings();
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

/** Refresh only instances already claimed by this workspace.
 * NEVER enumerate the server's administrative /instance/fetchInstances list:
 * that list contains the instances of all workspaces using the same Connect|API.
 */
async function syncInstances(tenant: string, baseUrl: string) {
  const claims = await prisma.connectInstanceClaim.findMany({
    where: { tenantId: tenant },
    select: { name: true },
  });
  const owned = claims.map((item) => item.name);
  const records = await prisma.connectApiInstance.findMany({
    where: {
      tenantId: tenant,
      tokenEncrypted: { not: null },
      name: { in: owned },
    },
    orderBy: { name: "asc" },
    take: 100,
  });
  for (const row of records) {
    if (!row.tokenEncrypted) continue;
    try {
      const result = await connectApiRequest<unknown>({
        baseUrl,
        apiKey: decryptSecret(row.tokenEncrypted),
        path: connectInstancePath(row.name, "connectionState"),
        timeoutMs: 8000,
      });
      const data =
        result && typeof result === "object"
          ? (result as Record<string, unknown>)
          : {};
      const nested =
        data.instance && typeof data.instance === "object"
          ? (data.instance as Record<string, unknown>)
          : data;
      const state = typeof nested.state === "string" ? nested.state : "unknown";
      await prisma.connectApiInstance.update({
        where: { id: row.id },
        data: { connectionState: state, present: true },
      });
    } catch {
      // A remote failure never deletes or reveals an existing binding.
      await prisma.connectApiInstance.update({
        where: { id: row.id },
        data: { connectionState: "unknown" },
      });
    }
  }
  return prisma.connectApiInstance.findMany({
    where: {
      tenantId: tenant,
      OR: [{ present: true }, { tokenEncrypted: { not: null } }],
    },
    orderBy: { name: "asc" },
  });
}

function publicInstance(
  instance: {
    id: string;
    name: string;
    displayName: string | null;
    integration: string;
    connectionState: string | null;
    number: string | null;
    profileName: string | null;
    present: boolean;
    tokenEncrypted: string | null;
    updatedAt: Date;
  },
  claimed = false,
) {
  return {
    id: instance.id,
    name: instance.name,
    displayName: instance.displayName ?? instance.name,
    integration: instance.integration,
    connectionState: instance.connectionState,
    number: instance.number,
    profileName: instance.profileName,
    present: instance.present,
    usable: Boolean(claimed && instance.tokenEncrypted && instance.present),
    updatedAt: instance.updatedAt,
  };
}

async function loadRemoteInstance(tenant: string, name: string) {
  const claim = await prisma.connectInstanceClaim.findUnique({
    where: { name },
  });
  if (!claim || claim.tenantId !== tenant) return null;
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
      const [workspace, instances, claims] = await Promise.all([
        prisma.tenant.findUnique({
          where: { id: tenant },
          select: { connectDefaultInstanceName: true },
        }),
        prisma.connectApiInstance.findMany({
          where: {
            tenantId: tenant,
            OR: [{ present: true }, { tokenEncrypted: { not: null } }],
          },
          orderBy: { name: "asc" },
        }),
        prisma.connectInstanceClaim.findMany({
          where: { tenantId: tenant },
          select: { name: true },
        }),
      ]);
      const owned = new Set(claims.map((claim) => claim.name));
      return {
        configured: Boolean(credentials()),
        mode: "global",
        defaultInstanceName: workspace?.connectDefaultInstanceName ?? null,
        instances: instances.map((instance) =>
          publicInstance(instance, owned.has(instance.name)),
        ),
        canManage: hasRole(request, ...adminRoles),
        canPublish: hasRole(request, ...publisherRoles),
      };
    },
  );

  // The administrative URL and token are server-owned, never accepted from a workspace.
  app.put(
    "/whatsapp/config",
    { preHandler: authenticated() },
    async (request, reply) => {
      if (!isManagerUser(request))
        return fail(reply, 403, "FORBIDDEN", "Use uma sessão do Manager.");
      return fail(
        reply,
        410,
        "GLOBAL_CONNECT_SETTINGS",
        "Configure URL e token somente no .env do servidor.",
      );
    },
  );

  app.post(
    "/whatsapp/sync",
    { preHandler: authenticated() },
    async (request, reply) => {
      if (!(await requireAdmin(request, reply))) return;
      const auth = credentials();
      if (!auth)
        return fail(
          reply,
          409,
          "CONNECT_API_NOT_CONFIGURED",
          "Configure primeiro a Connect API.",
        );
      try {
        const tenant = tenantId(request);
        const instances = await syncInstances(tenant, auth.baseUrl);
        const claims = await prisma.connectInstanceClaim.findMany({
          where: { tenantId: tenant },
          select: { name: true },
        });
        const owned = new Set(claims.map((claim) => claim.name));
        return {
          data: instances.map((instance) =>
            publicInstance(instance, owned.has(instance.name)),
          ),
        };
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
      const auth = credentials();
      if (!auth)
        return fail(
          reply,
          409,
          "CONNECT_API_NOT_CONFIGURED",
          "Configure primeiro a Connect API.",
        );
      const existing = await prisma.connectApiInstance.findFirst({
        where: {
          tenantId: tenant,
          present: true,
          OR: [{ displayName: body.data.name }, { name: body.data.name }],
        },
      });
      if (existing)
        return fail(
          reply,
          409,
          "INSTANCE_ALREADY_REGISTERED",
          "Já existe uma instância com esse nome neste espaço.",
        );
      const token = randomToken(36);
      const remoteName = remoteInstanceName(tenant, body.data.name);
      // Reserve global name atomically before creating the remote instance.
      const reservation = await prisma.$transaction(async (tx) => {
        await tx.connectInstanceClaim.create({
          data: { name: remoteName, tenantId: tenant },
        });
        return tx.connectApiInstance.create({
          data: {
            tenantId: tenant,
            name: remoteName,
            displayName: body.data.name,
            integration: body.data.provider,
            tokenEncrypted: encryptSecret(token),
            connectionState: "connecting",
            present: false,
          },
        });
      });
      try {
        await connectApiRequest({
          baseUrl: auth.baseUrl,
          apiKey: auth.apiKey,
          path: "instance/create",
          method: "POST",
          body: createWhatsAppInstancePayload(remoteName, token, body.data.provider),
        });
      } catch (error) {
        const mayHaveCreated = !(
          error instanceof ConnectApiError &&
          error.statusCode !== undefined &&
          error.statusCode < 500
        );
        if (!mayHaveCreated)
          await prisma.$transaction([
            prisma.connectApiInstance.delete({ where: { id: reservation.id } }),
            prisma.connectInstanceClaim.delete({ where: { name: remoteName } }),
          ]);
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
      return reply.code(201).send({ instance: publicInstance(instance, true) });
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
      const auth = credentials();
      if (!auth)
        return fail(
          reply,
          409,
          "CONNECT_API_NOT_CONFIGURED",
          "Configure primeiro a Connect API.",
        );
      // A global administrative token is never valid as a per-instance import token.
      if (body.data.token === auth.apiKey)
        return fail(
          reply,
          403,
          "INSTANCE_TOKEN_REQUIRED",
          "Use somente o token particular da instância.",
        );
      const priorClaim = await prisma.connectInstanceClaim.findUnique({
        where: { name: body.data.name },
      });
      if (priorClaim && priorClaim.tenantId !== tenant)
        return fail(
          reply,
          409,
          "INSTANCE_NOT_AVAILABLE",
          "Esta instância não pode ser vinculada neste espaço.",
        );
      try {
        const payload = await connectApiRequest<unknown>({
          baseUrl: auth.baseUrl,
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
        const instance = await prisma.$transaction(async (tx) => {
          const claim = await tx.connectInstanceClaim.findUnique({
            where: { name: remote.name },
          });
          if (claim && claim.tenantId !== tenant)
            throw new Error("INSTANCE_NOT_AVAILABLE");
          if (!claim)
            await tx.connectInstanceClaim.create({
              data: { name: remote.name, tenantId: tenant },
            });
          return tx.connectApiInstance.upsert({
            where: { tenantId_name: { tenantId: tenant, name: remote.name } },
            create: {
              tenantId: tenant,
              name: remote.name,
              displayName: remote.name,
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
        });
        await audit({
          tenantId: tenant,
          actorUserId: request.principal?.userId,
          action: "whatsapp.instance.imported",
          resourceType: "whatsapp-instance",
          resourceId: instance.id,
          metadata: { name: instance.name },
        });
        return reply
          .code(201)
          .send({ instance: publicInstance(instance, true) });
      } catch (error) {
        if (
          (error instanceof Prisma.PrismaClientKnownRequestError &&
            error.code === "P2002") ||
          (error instanceof Error && error.message === "INSTANCE_NOT_AVAILABLE")
        )
          return fail(
            reply,
            409,
            "INSTANCE_NOT_AVAILABLE",
            "Esta instância não pode ser vinculada neste espaço.",
          );
        const info = connectError(error);
        return fail(reply, info.status, info.code, info.message);
      }
    },
  );

  // Existing workspace records are intentionally NOT claimed by migration:
  // before changing their target to the global server, revalidate each scoped token.
  app.post(
    "/whatsapp/instances/claim",
    {
      preHandler: authenticated(),
      config: { rateLimit: { max: 6, timeWindow: "15 minutes" } },
    },
    async (request, reply) => {
      if (!(await requireAdmin(request, reply))) return;
      const body = z
        .object({ name: nameSchema, token: z.string().trim().min(8).max(4096) })
        .safeParse(request.body);
      if (!body.success)
        return fail(
          reply,
          400,
          "VALIDATION_ERROR",
          "Selecione uma instância válida.",
        );
      const tenant = tenantId(request);
      const record = await prisma.connectApiInstance.findFirst({
        where: { tenantId: tenant, name: body.data.name },
      });
      if (!record)
        return fail(
          reply,
          404,
          "INSTANCE_NOT_FOUND",
          "Vínculo indisponível neste espaço.",
        );
      const auth = credentials();
      if (!auth)
        return fail(
          reply,
          409,
          "CONNECT_API_NOT_CONFIGURED",
          "Configure a conexão global no .env.",
        );
      const token = body.data.token;
      if (token === auth.apiKey)
        return fail(
          reply,
          403,
          "INSTANCE_TOKEN_REQUIRED",
          "Esta instância precisa de token particular.",
        );
      const previous = await prisma.connectInstanceClaim.findUnique({
        where: { name: record.name },
      });
      if (previous && previous.tenantId !== tenant)
        return fail(
          reply,
          409,
          "INSTANCE_NOT_AVAILABLE",
          "A instância não pode ser vinculada neste espaço.",
        );
      try {
        const response = await connectApiRequest<unknown>({
          baseUrl: auth.baseUrl,
          apiKey: token,
          path: `instance/fetchInstances?instanceName=${encodeURIComponent(record.name)}`,
        });
        const remote = normalizeConnectInstances(response).find(
          (item) => item.name === record.name,
        );
        if (!remote || !isWhatsAppIntegration(remote.integration))
          return fail(
            reply,
            404,
            "INSTANCE_NOT_FOUND",
            "Token e instância não puderam ser confirmados.",
          );
        const updated = await prisma.$transaction(async (tx) => {
          if (!previous) {
            await tx.connectInstanceClaim.create({
              data: { name: record.name, tenantId: tenant },
            });
          }
          return tx.connectApiInstance.update({
            where: { id: record.id },
            data: {
              connectionState: remote.connectionState ?? "unknown",
              tokenEncrypted: encryptSecret(token),
              present: true,
              integration: remote.integration,
              displayName: record.displayName ?? record.name,
            },
          });
        });
        await audit({
          tenantId: tenant,
          actorUserId: request.principal?.userId,
          action: "whatsapp.instance.claimed",
          resourceType: "whatsapp-instance",
          resourceId: record.id,
        });
        return { instance: publicInstance(updated, true) };
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002"
        )
          return fail(
            reply,
            409,
            "INSTANCE_NOT_AVAILABLE",
            "A instância já pertence a outro espaço.",
          );
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
      const updated = await prisma.tenant.update({
        where: { id: tenant },
        data: { connectDefaultInstanceName: body.data.instanceName },
      });
      await audit({
        tenantId: tenant,
        actorUserId: request.principal?.userId,
        action: "whatsapp.instance.default_changed",
        resourceType: "whatsapp-instance",
        resourceId: body.data.instanceName ?? undefined,
      });
      return { defaultInstanceName: updated.connectDefaultInstanceName };
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
      if (!["connect", "pairing", "status", "restart", "logout"].includes(action))
        return fail(
          reply,
          404,
          "ACTION_NOT_FOUND",
          "Ação de instância não encontrada.",
        );
      let pairingNumber: string | null = null;
      if (action === "pairing") {
        const body = z.object({ number: z.string().trim().min(8).max(24) }).safeParse(request.body);
        if (!body.success) return fail(reply, 400, "PAIRING_NUMBER_REQUIRED", "Informe o número com DDI e DDD.");
        pairingNumber = normalizedNumber(body.data.number);
        if (!pairingNumber)
          return fail(reply, 400, "PAIRING_NUMBER_INVALID", "Use telefone internacional com DDI, DDD e número.");
      }
      const tenant = tenantId(request);
      const instance = await loadRemoteInstance(tenant, parsedName.data);
      if (!instance || !instance.tokenEncrypted)
        return fail(
          reply,
          404,
          "INSTANCE_NOT_USABLE",
          "A instância não está vinculada à Scout.",
        );
      const auth = credentials();
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
            : action === "pairing" ? "connect" : action;
      try {
        const result = await connectApiRequest<unknown>({
          baseUrl: auth.baseUrl,
          apiKey: token,
          method,
          path: action === "pairing" && pairingNumber
            ? connectPairingPath(instance.name, pairingNumber)
            : connectInstancePath(instance.name, apiAction),
        });
        if (result && typeof result === "object" && (result as Record<string, unknown>).error === true)
          return fail(reply, 502, "CONNECT_PAIRING_FAILED", "Não foi possível obter o QR Code ou código. Tente novamente.");
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
            typeof detail.state === "string" ? detail.state
              : typeof detail.status === "string" ? detail.status
              : typeof detail.connectionStatus === "string" ? detail.connectionStatus
              : "unknown";
          const updated = await prisma.connectApiInstance.update({
            where: { id: instance.id },
            data: { connectionState: state },
          });
          return { instance: publicInstance(updated, true), state };
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
    { preHandler: authenticated(), config: { rateLimit: { max: 12, timeWindow: "15 minutes" } } },
    async (request, reply) => {
      if (!(await requireAdmin(request, reply))) return;
      const { name } = request.params as { name: string };
      const parsedName = nameSchema.safeParse(name);
      if (!parsedName.success)
        return fail(reply, 400, "INSTANCE_NAME_INVALID", "Nome de instância inválido.");
      const tenant = tenantId(request);
      const instance = await prisma.connectApiInstance.findFirst({
        where: { tenantId: tenant, name: parsedName.data, present: true },
      });
      if (!instance)
        return fail(reply, 404, "INSTANCE_NOT_FOUND", "Instância indisponível neste espaço.");

      // Database claim, not the browser or the remote server, owns this decision.
      const claim = await prisma.connectInstanceClaim.findUnique({
        where: { name: instance.name },
      });
      if (claim && claim.tenantId !== tenant)
        return fail(reply, 403, "INSTANCE_NOT_OWNED", "Esta instância pertence a outro espaço.");

      const remotelyClaimed = claim?.tenantId === tenant && Boolean(instance.tokenEncrypted);
      let remoteResult: "removed" | "already-missing" | "not-claimed" = "not-claimed";
      if (remotelyClaimed) {
        const connection = credentials();
        if (!connection)
          return fail(reply, 409, "CONNECT_API_NOT_CONFIGURED", "A conexão Connect|API está indisponível.");
        const instanceToken = decryptSecret(instance.tokenEncrypted!);
        try {
          remoteResult = await deleteRemoteInstance(instanceToken, (apiKey) =>
            connectApiRequest<unknown>({
              baseUrl: connection.baseUrl,
              apiKey,
              method: "DELETE",
              path: connectInstancePath(instance.name, "delete"),
              timeoutMs: 20000,
            }),
          );
        } catch (error) {
          const info = connectError(error);
          return fail(
            reply,
            info.status,
            "REMOTE_DELETE_FAILED",
            "A instância não foi excluída na Connect|API. O vínculo local foi preservado para uma nova tentativa.",
          );
        }
      }

      // The same transaction deactivates only this tenant's record and releases
      // its remote name claim. Historical publication/audit rows remain intact.
      try {
        await prisma.$transaction(async (tx) => {
          await tx.connectApiInstance.updateMany({
            where: { id: instance.id, tenantId: tenant, present: true },
            data: {
              present: false,
              tokenEncrypted: null,
              connectionState: "deleted",
            },
          });
          await tx.connectInstanceClaim.deleteMany({
            where: { name: instance.name, tenantId: tenant },
          });
          await tx.tenant.updateMany({
            where: { id: tenant, connectDefaultInstanceName: instance.name },
            data: { connectDefaultInstanceName: null },
          });
        });
      } catch {
        return fail(reply, 500, "LOCAL_DELETE_FAILED", "Não foi possível concluir a remoção local. Atualize e tente novamente.");
      }
      await audit({
        tenantId: tenant,
        actorUserId: request.principal?.userId,
        action: remotelyClaimed ? "whatsapp.instance.deleted" : "whatsapp.instance.unlinked",
        resourceType: "whatsapp-instance",
        resourceId: instance.id,
        metadata: {
          name: instance.name,
          remoteResult,
          // Tokens, numbers, payloads and full Connect configuration must not enter audit.
        },
      });
      return {
        deleted: true,
        remoteDeleted: remoteResult === "removed" || remoteResult === "already-missing",
        localOnly: remoteResult === "not-claimed",
      };
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
      const auth = credentials();
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
          baseUrl: auth.baseUrl,
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
