import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { CronExpressionParser } from "cron-parser";
import { authenticator } from "otplib";
import QRCode from "qrcode";
import argon2 from "argon2";
import { connect as connectAmqp } from "amqplib";
import type Redis from "ioredis";
import { Prisma, TenantRole, JobStatus } from "@prisma/client";
import { z } from "zod";
import {
  instanceCreateSchema,
  jobCreateSchema,
  loginSchema,
  mfaCodeSchema,
  profileUpdateSchema,
  scheduleCreateSchema,
  slugSchema,
  sourceCreateSchema,
  tokenCreateSchema,
  webhookCreateSchema,
} from "@argws/scout-schemas";
import { encryptSecret, randomToken, sha256 } from "@argws/scout-shared/crypto";
import { assertSafePublicUrl } from "@argws/scout-shared/url-policy";
import {
  checkObjectStorage,
  getArtifactStream,
} from "@argws/scout-shared/storage";
import { renderInputTemplate } from "@argws/scout-core";
import { audit } from "./audit.ts";
import { prisma } from "./db.ts";
import { registerWhatsAppRoutes } from "./whatsapp-routes.ts";
import {
  authenticated,
  clearSessionCookies,
  createSession,
  hasRole,
  isManagerUser,
  mfaSecret,
  requireScope,
  setSessionCookies,
  verifyPassword,
  verifyPreAuth,
} from "./auth.ts";

const staffRoles = [TenantRole.OWNER, TenantRole.ADMIN, TenantRole.OPERATOR];
const adminRoles = [TenantRole.OWNER, TenantRole.ADMIN];
const ownerRoles = [TenantRole.OWNER];

function fail(
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
): FastifyReply {
  return reply.code(status).send({ error: { code, message } });
}

function parsed<T>(
  schema: {
    safeParse: (value: unknown) =>
      | { success: true; data: T }
      | {
          success: false;
          error: { issues: Array<{ path: PropertyKey[]; message: string }> };
        };
  },
  value: unknown,
  reply: FastifyReply,
): T | null {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  reply.code(400).send({
    error: {
      code: "VALIDATION_ERROR",
      message: "Revise os campos informados.",
      fields: result.error.issues.map((issue) => ({
        path: issue.path.map(String).join("."),
        message: issue.message,
      })),
    },
  });
  return null;
}

function slugify(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 63);
}

function auditActor(request: FastifyRequest): string | undefined {
  return request.principal?.userId;
}
function tenantId(request: FastifyRequest): string {
  return request.principal!.tenantId;
}

async function getInstance(request: FastifyRequest, id: string) {
  const principal = request.principal!;
  if (principal.kind === "api-token" && principal.instanceId !== id)
    return null;
  return prisma.instance.findFirst({
    where: { id, tenantId: principal.tenantId, enabled: true },
  });
}

async function mayManage(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<boolean> {
  if (!isManagerUser(request) || !hasRole(request, ...staffRoles)) {
    fail(
      reply,
      403,
      "FORBIDDEN",
      "Esta ação exige perfil de operação na organização.",
    );
    return false;
  }
  return true;
}

async function mayAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<boolean> {
  if (!isManagerUser(request) || !hasRole(request, ...adminRoles)) {
    fail(reply, 403, "FORBIDDEN", "Esta ação exige perfil de administração.");
    return false;
  }
  return true;
}

function queueOutbox(
  tx: Prisma.TransactionClient,
  input: {
    tenantId: string;
    eventType: string;
    routingKey: string;
    aggregateId?: string;
    payload: Prisma.InputJsonValue;
  },
) {
  return tx.outbox.create({
    data: {
      tenantId: input.tenantId,
      eventType: input.eventType,
      routingKey: input.routingKey,
      aggregateId: input.aggregateId,
      payload: input.payload,
    },
  });
}

export async function registerRoutes(
  app: FastifyInstance,
  options: { prefix?: string; redis: Redis },
): Promise<void> {
  await registerWhatsAppRoutes(app);
  app.post(
    "/auth/login",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const body = parsed(loginSchema, request.body, reply);
      if (!body) return;
      const user = await prisma.user.findUnique({
        where: { email: body.email.toLowerCase() },
      });
      if (
        !user ||
        user.disabledAt ||
        !(await verifyPassword(user.passwordHash, body.password))
      )
        return fail(reply, 401, "LOGIN_INVALID", "E-mail ou senha inválidos.");
      const memberships = await prisma.membership.findMany({
        where: { userId: user.id },
        include: { tenant: true },
        orderBy: { createdAt: "asc" },
      });
      const membership = body.tenantSlug
        ? memberships.find((item) => item.tenant.slug === body.tenantSlug)
        : memberships[0];
      if (!membership)
        return fail(
          reply,
          401,
          "TENANT_UNAVAILABLE",
          "Usuário não pertence à organização solicitada.",
        );
      const ownerMustEnroll =
        membership.role === TenantRole.OWNER &&
        process.env.SCOUT_MFA_REQUIRED_FOR_OWNER !== "false";
      if (user.mfaEnabled || ownerMustEnroll) {
        const preAuthToken = app.jwt.sign(
          { type: "preauth", tenantId: membership.tenantId },
          { sub: user.id, expiresIn: "5m" },
        );
        return reply.send(
          user.mfaEnabled
            ? { mfaRequired: true, preAuthToken }
            : { mfaSetupRequired: true, preAuthToken },
        );
      }
      await createSession(app, reply, user.id, membership.tenantId);
      return reply.send({
        authenticated: true,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          role: membership.role,
          tenant: {
            id: membership.tenant.id,
            name: membership.tenant.name,
            slug: membership.tenant.slug,
          },
        },
      });
    },
  );

  app.post(
    "/auth/mfa/setup",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (request, reply) => {
      let preAuth: { userId: string; tenantId: string };
      try {
        preAuth = await verifyPreAuth(request);
      } catch {
        return fail(
          reply,
          401,
          "PREAUTH_INVALID",
          "A etapa de autenticação expirou. Entre novamente.",
        );
      }
      const membership = await prisma.membership.findUnique({
        where: {
          tenantId_userId: {
            tenantId: preAuth.tenantId,
            userId: preAuth.userId,
          },
        },
      });
      if (
        !membership ||
        (membership.role !== TenantRole.OWNER &&
          membership.role !== TenantRole.ADMIN)
      )
        return fail(
          reply,
          403,
          "MFA_SETUP_FORBIDDEN",
          "A configuração inicial de MFA está disponível para administradores.",
        );
      const user = await prisma.user.findUnique({
        where: { id: preAuth.userId },
      });
      if (!user)
        return fail(reply, 401, "USER_UNAVAILABLE", "Usuário indisponível.");
      const secret = authenticator.generateSecret();
      await prisma.user.update({
        where: { id: user.id },
        data: { totpPendingEncrypted: encryptSecret(secret) },
      });
      const otpauthUrl = authenticator.keyuri(
        user.email,
        "ARGWS Scout",
        secret,
      );
      return reply.send({
        manualKey: secret,
        qrCodeDataUrl: await QRCode.toDataURL(otpauthUrl, {
          margin: 1,
          width: 240,
        }),
      });
    },
  );

  app.post(
    "/auth/mfa/confirm",
    { config: { rateLimit: { max: 8, timeWindow: "1 minute" } } },
    async (request, reply) => {
      let preAuth: { userId: string; tenantId: string };
      try {
        preAuth = await verifyPreAuth(request);
      } catch {
        return fail(
          reply,
          401,
          "PREAUTH_INVALID",
          "A etapa de autenticação expirou. Entre novamente.",
        );
      }
      const body = parsed(mfaCodeSchema, request.body, reply);
      if (!body) return;
      const user = await prisma.user.findUnique({
        where: { id: preAuth.userId },
      });
      if (!user?.totpPendingEncrypted)
        return fail(
          reply,
          409,
          "MFA_SETUP_REQUIRED",
          "Gere um novo segredo de configuração.",
        );
      const { decryptSecret } = await import("@argws/scout-shared/crypto");
      if (
        !authenticator.check(
          body.code,
          decryptSecret(user.totpPendingEncrypted),
        )
      )
        return fail(
          reply,
          401,
          "MFA_CODE_INVALID",
          "Código de autenticação inválido.",
        );
      await prisma.user.update({
        where: { id: user.id },
        data: {
          totpSecretEncrypted: user.totpPendingEncrypted,
          totpPendingEncrypted: null,
          mfaEnabled: true,
        },
      });
      await createSession(app, reply, user.id, preAuth.tenantId);
      await audit({
        tenantId: preAuth.tenantId,
        actorUserId: user.id,
        action: "auth.mfa.enabled",
        resourceType: "user",
        resourceId: user.id,
      });
      return reply.send({ authenticated: true });
    },
  );

  app.post(
    "/auth/mfa/verify",
    { config: { rateLimit: { max: 8, timeWindow: "1 minute" } } },
    async (request, reply) => {
      let preAuth: { userId: string; tenantId: string };
      try {
        preAuth = await verifyPreAuth(request);
      } catch {
        return fail(
          reply,
          401,
          "PREAUTH_INVALID",
          "A etapa de autenticação expirou. Entre novamente.",
        );
      }
      const body = parsed(mfaCodeSchema, request.body, reply);
      if (!body) return;
      const secret = await mfaSecret(preAuth.userId);
      if (!secret || !authenticator.check(body.code, secret))
        return fail(
          reply,
          401,
          "MFA_CODE_INVALID",
          "Código de autenticação inválido.",
        );
      const membership = await prisma.membership.findUnique({
        where: {
          tenantId_userId: {
            tenantId: preAuth.tenantId,
            userId: preAuth.userId,
          },
        },
      });
      if (!membership)
        return fail(
          reply,
          401,
          "TENANT_UNAVAILABLE",
          "Organização indisponível.",
        );
      await createSession(app, reply, preAuth.userId, preAuth.tenantId);
      return reply.send({ authenticated: true });
    },
  );

  app.post("/auth/refresh", async (request, reply) => {
    const refresh = request.cookies.scout_refresh;
    if (!refresh) {
      clearSessionCookies(reply);
      return fail(
        reply,
        401,
        "REFRESH_REQUIRED",
        "Sessão expirada. Entre novamente.",
      );
    }
    try {
      const claims = await app.jwt.verify<{
        type: string;
        tenantId: string;
        sub: string;
        jti?: string;
      }>(refresh);
      if (claims.type !== "refresh" || !claims.jti)
        throw new Error("Invalid refresh token.");
      const session = await prisma.authSession.findFirst({
        where: {
          id: claims.jti,
          userId: claims.sub,
          tenantId: claims.tenantId,
          refreshHash: sha256(refresh),
          revokedAt: null,
          expiresAt: { gt: new Date() },
        },
      });
      if (!session) throw new Error("Refresh session not found.");
      await setSessionCookies(
        app,
        reply,
        claims.sub,
        claims.tenantId,
        session.id,
      );
      await prisma.authSession.update({
        where: { id: session.id },
        data: { lastSeenAt: new Date() },
      });
      return reply.send({ authenticated: true });
    } catch {
      clearSessionCookies(reply);
      return fail(
        reply,
        401,
        "REFRESH_INVALID",
        "Sessão expirada. Entre novamente.",
      );
    }
  });

  app.post("/auth/logout", async (request, reply) => {
    const refresh = request.cookies.scout_refresh;
    if (refresh) {
      try {
        const claims = await app.jwt.verify<{ jti?: string }>(refresh);
        if (claims.jti)
          await prisma.authSession.updateMany({
            where: {
              id: claims.jti,
              refreshHash: sha256(refresh),
              revokedAt: null,
            },
            data: { revokedAt: new Date() },
          });
      } catch {
        /* sessão já expirada */
      }
    }
    clearSessionCookies(reply);
    return reply.code(204).send();
  });

  app.get(
    "/auth/me",
    { preHandler: authenticated() },
    async (request, reply) => {
      if (request.principal?.kind !== "user")
        return fail(
          reply,
          401,
          "USER_SESSION_REQUIRED",
          "Acesse o Manager com uma conta de usuário.",
        );
      const membership = await prisma.membership.findUnique({
        where: {
          tenantId_userId: {
            tenantId: tenantId(request),
            userId: request.principal.userId!,
          },
        },
        include: { user: true, tenant: true },
      });
      if (!membership)
        return fail(
          reply,
          401,
          "MEMBERSHIP_REQUIRED",
          "Organização indisponível.",
        );
      return {
        user: {
          id: membership.user.id,
          email: membership.user.email,
          name: membership.user.name,
          profile: membership.user.profile,
          mfaEnabled: membership.user.mfaEnabled,
        },
        role: membership.role,
        tenant: {
          id: membership.tenant.id,
          name: membership.tenant.name,
          slug: membership.tenant.slug,
        },
      };
    },
  );

  app.patch(
    "/profile",
    { preHandler: authenticated() },
    async (request, reply) => {
      if (request.principal?.kind !== "user")
        return fail(
          reply,
          403,
          "USER_SESSION_REQUIRED",
          "Ação disponível somente para usuários do Manager.",
        );
      const body = parsed(profileUpdateSchema, request.body, reply);
      if (!body) return;
      const user = await prisma.user.update({
        where: { id: request.principal.userId },
        data: {
          name: body.name,
          profile: body.profile as Prisma.InputJsonValue,
        },
        select: { id: true, email: true, name: true, profile: true },
      });
      await audit({
        tenantId: tenantId(request),
        actorUserId: user.id,
        action: "profile.updated",
        resourceType: "user",
        resourceId: user.id,
      });
      return { user };
    },
  );

  app.post(
    "/profile/mfa/setup",
    {
      preHandler: authenticated(),
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      if (request.principal?.kind !== "user")
        return fail(
          reply,
          403,
          "USER_SESSION_REQUIRED",
          "MFA de perfil exige uma sessão do Manager.",
        );
      const user = await prisma.user.findUnique({
        where: { id: request.principal.userId },
      });
      if (!user || user.mfaEnabled)
        return fail(
          reply,
          409,
          "MFA_ALREADY_ENABLED",
          "MFA já está ativa ou o usuário não existe.",
        );
      const secret = authenticator.generateSecret();
      await prisma.user.update({
        where: { id: user.id },
        data: { totpPendingEncrypted: encryptSecret(secret) },
      });
      return {
        manualKey: secret,
        qrCodeDataUrl: await QRCode.toDataURL(
          authenticator.keyuri(user.email, "ARGWS Scout", secret),
          { margin: 1, width: 240 },
        ),
      };
    },
  );

  app.post(
    "/profile/mfa/confirm",
    {
      preHandler: authenticated(),
      config: { rateLimit: { max: 8, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      if (request.principal?.kind !== "user")
        return fail(
          reply,
          403,
          "USER_SESSION_REQUIRED",
          "MFA de perfil exige uma sessão do Manager.",
        );
      const body = parsed(mfaCodeSchema, request.body, reply);
      if (!body) return;
      const user = await prisma.user.findUnique({
        where: { id: request.principal.userId },
      });
      if (!user?.totpPendingEncrypted)
        return fail(
          reply,
          409,
          "MFA_SETUP_REQUIRED",
          "Gere um novo segredo de configuração.",
        );
      const { decryptSecret } = await import("@argws/scout-shared/crypto");
      if (
        !authenticator.check(
          body.code,
          decryptSecret(user.totpPendingEncrypted),
        )
      )
        return fail(
          reply,
          401,
          "MFA_CODE_INVALID",
          "Código de autenticação inválido.",
        );
      await prisma.user.update({
        where: { id: user.id },
        data: {
          totpSecretEncrypted: user.totpPendingEncrypted,
          totpPendingEncrypted: null,
          mfaEnabled: true,
        },
      });
      await audit({
        tenantId: tenantId(request),
        actorUserId: user.id,
        action: "auth.mfa.enabled",
        resourceType: "user",
        resourceId: user.id,
      });
      return { enabled: true };
    },
  );

  app.get("/users", { preHandler: authenticated() }, async (request, reply) => {
    if (!(await mayAdmin(request, reply))) return;
    const rows = await prisma.membership.findMany({
      where: { tenantId: tenantId(request) },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            name: true,
            mfaEnabled: true,
            disabledAt: true,
            createdAt: true,
          },
        },
      },
      orderBy: { createdAt: "asc" },
    });
    return { data: rows.map(({ role, user }) => ({ ...user, role })) };
  });

  app.post(
    "/users",
    { preHandler: authenticated() },
    async (request, reply) => {
      if (!(await mayAdmin(request, reply))) return;
      const body = parsed(
        z.object({
          name: z.string().trim().min(2).max(120),
          email: z.string().email().max(254),
          password: z.string().min(16).max(256),
          role: z.enum(["ADMIN", "OPERATOR", "VIEWER"]),
        }),
        request.body,
        reply,
      );
      if (!body) return;
      const email = body.email.toLowerCase();
      let user = await prisma.user.findUnique({ where: { email } });
      if (
        user &&
        (await prisma.membership.findUnique({
          where: {
            tenantId_userId: { tenantId: tenantId(request), userId: user.id },
          },
        }))
      )
        return fail(
          reply,
          409,
          "USER_EXISTS",
          "Usuário já pertence a esta organização.",
        );
      if (!user)
        user = await prisma.user.create({
          data: {
            name: body.name,
            email,
            passwordHash: await argon2.hash(body.password, {
              type: argon2.argon2id,
            }),
          },
        });
      await prisma.membership.create({
        data: { tenantId: tenantId(request), userId: user.id, role: body.role },
      });
      await audit({
        tenantId: tenantId(request),
        actorUserId: auditActor(request),
        action: "user.created",
        resourceType: "user",
        resourceId: user.id,
        metadata: { role: body.role },
      });
      return reply.code(201).send({
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          role: body.role,
        },
      });
    },
  );

  app.post(
    "/users/:userId/mfa/reset",
    { preHandler: authenticated() },
    async (request, reply) => {
      if (!hasRole(request, TenantRole.OWNER))
        return fail(
          reply,
          403,
          "OWNER_REQUIRED",
          "Somente OWNER pode recuperar MFA de outro perfil.",
        );
      const { userId } = request.params as { userId: string };
      const membership = await prisma.membership.findUnique({
        where: { tenantId_userId: { tenantId: tenantId(request), userId } },
      });
      if (!membership)
        return fail(
          reply,
          404,
          "USER_NOT_FOUND",
          "Usuário não encontrado nesta organização.",
        );
      await prisma.$transaction([
        prisma.user.update({
          where: { id: userId },
          data: {
            mfaEnabled: false,
            totpSecretEncrypted: null,
            totpPendingEncrypted: null,
          },
        }),
        prisma.authSession.updateMany({
          where: { userId, tenantId: tenantId(request), revokedAt: null },
          data: { revokedAt: new Date() },
        }),
        prisma.auditLog.create({
          data: {
            tenantId: tenantId(request),
            actorUserId: auditActor(request),
            action: "user.mfa.reset",
            resourceType: "user",
            resourceId: userId,
          },
        }),
      ]);
      return reply.code(204).send();
    },
  );

  app.get(
    "/overview",
    { preHandler: requireScope("instances:read") },
    async (request) => {
      const principal = request.principal!;
      const instanceFilter =
        principal.kind === "api-token" ? { id: principal.instanceId } : {};
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const jobWhere = {
        tenantId: principal.tenantId,
        ...(principal.instanceId ? { instanceId: principal.instanceId } : {}),
      };
      const [
        instances,
        sources,
        jobs,
        jobStatuses,
        completedToday,
        recentJobs,
      ] = await Promise.all([
        prisma.instance.count({
          where: {
            tenantId: principal.tenantId,
            enabled: true,
            ...instanceFilter,
          },
        }),
        prisma.source.count({
          where: {
            instance: {
              tenantId: principal.tenantId,
              enabled: true,
              ...instanceFilter,
            },
            enabled: true,
          },
        }),
        prisma.job.count({ where: jobWhere }),
        prisma.job.groupBy({
          by: ["status"],
          where: jobWhere,
          _count: { _all: true },
        }),
        prisma.job.groupBy({
          by: ["status"],
          where: { ...jobWhere, createdAt: { gte: since } },
          _count: { _all: true },
        }),
        prisma.job.findMany({
          where: jobWhere,
          orderBy: { createdAt: "desc" },
          take: 8,
          include: {
            source: { select: { name: true } },
            instance: { select: { name: true } },
          },
        }),
      ]);
      const statusCounts = Object.fromEntries(
        jobStatuses.map(({ status, _count }) => [status, _count._all]),
      );
      const todayCounts = Object.fromEntries(
        completedToday.map(({ status, _count }) => [status, _count._all]),
      );
      const finishedToday =
        (todayCounts.SUCCEEDED ?? 0) + (todayCounts.FAILED ?? 0);
      return {
        stats: {
          instances,
          sources,
          jobs,
          queued: statusCounts.QUEUED ?? 0,
          running: statusCounts.RUNNING ?? 0,
          succeeded: statusCounts.SUCCEEDED ?? 0,
          failed: statusCounts.FAILED ?? 0,
          successRate24h:
            finishedToday === 0
              ? null
              : Math.round(
                  ((todayCounts.SUCCEEDED ?? 0) / finishedToday) * 100,
                ),
        },
        recentJobs,
      };
    },
  );

  app.get(
    "/instances",
    { preHandler: requireScope("instances:read") },
    async (request) => {
      const principal = request.principal!;
      const data = await prisma.instance.findMany({
        where: {
          tenantId: principal.tenantId,
          enabled: true,
          ...(principal.instanceId ? { id: principal.instanceId } : {}),
        },
        include: { _count: { select: { sources: true, jobs: true } } },
        orderBy: { createdAt: "desc" },
      });
      return { data };
    },
  );

  app.post(
    "/instances",
    { preHandler: authenticated() },
    async (request, reply) => {
      if (!(await mayManage(request, reply))) return;
      const body = parsed(instanceCreateSchema, request.body, reply);
      if (!body) return;
      const slug = body.slug ?? slugify(body.name);
      if (!slugSchema.safeParse(slug).success)
        return fail(reply, 400, "SLUG_INVALID", "Nome curto inválido.");
      const instance = await prisma.instance.create({
        data: {
          tenantId: tenantId(request),
          name: body.name,
          slug,
          description: body.description,
          metadata: body.metadata as Prisma.InputJsonValue,
        },
      });
      await audit({
        tenantId: tenantId(request),
        actorUserId: auditActor(request),
        action: "instance.created",
        resourceType: "instance",
        resourceId: instance.id,
      });
      return reply.code(201).send({ instance });
    },
  );

  app.get(
    "/instances/:instanceId",
    { preHandler: requireScope("instances:read") },
    async (request, reply) => {
      const { instanceId } = request.params as { instanceId: string };
      const instance = await getInstance(request, instanceId);
      if (!instance)
        return fail(
          reply,
          404,
          "INSTANCE_NOT_FOUND",
          "Instância não encontrada.",
        );
      const [sources, jobs, schedules] = await Promise.all([
        prisma.source.findMany({
          where: { instanceId },
          orderBy: { createdAt: "desc" },
        }),
        prisma.job.findMany({
          where: { instanceId },
          take: 12,
          orderBy: { createdAt: "desc" },
          include: { source: { select: { name: true } } },
        }),
        prisma.schedule.findMany({
          where: { instanceId },
          orderBy: { nextRunAt: "asc" },
        }),
      ]);
      return { instance, sources, recentJobs: jobs, schedules };
    },
  );

  app.patch(
    "/instances/:instanceId",
    { preHandler: authenticated() },
    async (request, reply) => {
      if (!(await mayManage(request, reply))) return;
      const { instanceId } = request.params as { instanceId: string };
      const body = parsed(
        z.object({
          name: z.string().trim().min(2).max(120).optional(),
          description: z.string().trim().max(500).nullable().optional(),
          metadata: z.record(z.unknown()).optional(),
          enabled: z.boolean().optional(),
        }),
        request.body,
        reply,
      );
      if (!body) return;
      const existing = await prisma.instance.findFirst({
        where: { id: instanceId, tenantId: tenantId(request) },
      });
      if (!existing)
        return fail(
          reply,
          404,
          "INSTANCE_NOT_FOUND",
          "Instância não encontrada.",
        );
      const instance = await prisma.instance.update({
        where: { id: instanceId },
        data: {
          ...body,
          metadata: body.metadata as Prisma.InputJsonValue | undefined,
        },
      });
      await audit({
        tenantId: tenantId(request),
        actorUserId: auditActor(request),
        action: "instance.updated",
        resourceType: "instance",
        resourceId: instance.id,
      });
      return { instance };
    },
  );

  app.get(
    "/instances/:instanceId/sources",
    { preHandler: requireScope("sources:read") },
    async (request, reply) => {
      const { instanceId } = request.params as { instanceId: string };
      if (!(await getInstance(request, instanceId)))
        return fail(
          reply,
          404,
          "INSTANCE_NOT_FOUND",
          "Instância não encontrada.",
        );
      const data = await prisma.source.findMany({
        where: { instanceId },
        orderBy: { createdAt: "desc" },
      });
      return { data };
    },
  );

  app.post(
    "/instances/:instanceId/sources",
    { preHandler: authenticated() },
    async (request, reply) => {
      if (!(await mayManage(request, reply))) return;
      const { instanceId } = request.params as { instanceId: string };
      const instance = await getInstance(request, instanceId);
      if (!instance)
        return fail(
          reply,
          404,
          "INSTANCE_NOT_FOUND",
          "Instância não encontrada.",
        );
      const body = parsed(sourceCreateSchema, request.body, reply);
      if (!body) return;
      try {
        await assertSafePublicUrl(
          body.url.replace(/\{\{input\.[\w.-]+\}\}/g, "probe"),
          body.allowedHosts,
          process.env.SCOUT_ALLOW_HTTP === "true",
        );
      } catch (error) {
        return fail(
          reply,
          400,
          "SOURCE_URL_BLOCKED",
          error instanceof Error ? error.message : "URL não permitida.",
        );
      }
      const source = await prisma.source.create({
        data: {
          instanceId,
          name: body.name,
          engine: body.engine,
          urlTemplate: body.url,
          allowedHosts: body.allowedHosts,
          selector: body.selector,
          respectRobots: body.respectRobots,
          captureScreenshot: body.captureScreenshot,
          requestIntervalMs: body.requestIntervalMs,
        },
      });
      await audit({
        tenantId: tenantId(request),
        actorUserId: auditActor(request),
        action: "source.created",
        resourceType: "source",
        resourceId: source.id,
      });
      return reply.code(201).send({ source });
    },
  );

  app.patch(
    "/sources/:sourceId",
    { preHandler: authenticated() },
    async (request, reply) => {
      if (!(await mayManage(request, reply))) return;
      const { sourceId } = request.params as { sourceId: string };
      const source = await prisma.source.findFirst({
        where: { id: sourceId, instance: { tenantId: tenantId(request) } },
      });
      if (!source)
        return fail(reply, 404, "SOURCE_NOT_FOUND", "Fonte não encontrada.");
      const body = parsed(
        z.object({
          name: z.string().trim().min(2).max(120).optional(),
          enabled: z.boolean().optional(),
          selector: z.string().max(500).nullable().optional(),
          respectRobots: z.boolean().optional(),
        }),
        request.body,
        reply,
      );
      if (!body) return;
      const updated = await prisma.source.update({
        where: { id: sourceId },
        data: body,
      });
      await audit({
        tenantId: tenantId(request),
        actorUserId: auditActor(request),
        action: "source.updated",
        resourceType: "source",
        resourceId: sourceId,
      });
      return { source: updated };
    },
  );

  app.post(
    "/instances/:instanceId/jobs",
    { preHandler: requireScope("jobs:create") },
    async (request, reply) => {
      const { instanceId } = request.params as { instanceId: string };
      const instance = await getInstance(request, instanceId);
      if (!instance)
        return fail(
          reply,
          404,
          "INSTANCE_NOT_FOUND",
          "Instância não encontrada.",
        );
      if (
        request.principal?.kind === "user" &&
        !hasRole(request, ...staffRoles)
      )
        return fail(
          reply,
          403,
          "FORBIDDEN",
          "Perfil sem permissão para criar jobs.",
        );
      const body = parsed(jobCreateSchema, request.body, reply);
      if (!body) return;
      const source = await prisma.source.findFirst({
        where: { id: body.sourceId, instanceId, enabled: true },
      });
      if (!source)
        return fail(
          reply,
          404,
          "SOURCE_NOT_FOUND",
          "Fonte ativa não encontrada nesta instância.",
        );
      if (JSON.stringify(body.input).length > 64_000)
        return fail(
          reply,
          413,
          "INPUT_TOO_LARGE",
          "Entrada acima do limite de 64 KB.",
        );
      let url: string;
      try {
        url = renderInputTemplate(source.urlTemplate, body.input);
        await assertSafePublicUrl(
          url,
          source.allowedHosts,
          process.env.SCOUT_ALLOW_HTTP === "true",
        );
      } catch (error) {
        return fail(
          reply,
          400,
          "SOURCE_URL_BLOCKED",
          error instanceof Error ? error.message : "URL não permitida.",
        );
      }
      const job = await prisma.$transaction(async (tx) => {
        const created = await tx.job.create({
          data: {
            tenantId: instance.tenantId,
            instanceId,
            sourceId: source.id,
            createdById: request.principal?.userId,
            input: body.input as Prisma.InputJsonValue,
          },
        });
        await queueOutbox(tx, {
          tenantId: instance.tenantId,
          eventType: "job.execute",
          routingKey: source.engine === "HTTP" ? "jobs.http" : "jobs.browser",
          aggregateId: created.id,
          payload: {
            jobId: created.id,
            tenantId: instance.tenantId,
            engine: source.engine,
          },
        });
        return created;
      });
      await audit({
        tenantId: tenantId(request),
        actorUserId: auditActor(request),
        action: "job.created",
        resourceType: "job",
        resourceId: job.id,
        metadata: { sourceId: source.id, engine: source.engine },
      });
      return reply.code(202).send({ job });
    },
  );

  app.get(
    "/jobs",
    { preHandler: requireScope("jobs:read") },
    async (request) => {
      const principal = request.principal!;
      const query = request.query as {
        instanceId?: string;
        status?: string;
        cursor?: string;
      };
      const where: Prisma.JobWhereInput = {
        tenantId: principal.tenantId,
        ...(principal.instanceId ? { instanceId: principal.instanceId } : {}),
        ...(query.instanceId ? { instanceId: query.instanceId } : {}),
        ...(query.status &&
        Object.values(JobStatus).includes(query.status as JobStatus)
          ? { status: query.status as JobStatus }
          : {}),
      };
      const rows = await prisma.job.findMany({
        where,
        take: 50,
        ...(query.cursor ? { skip: 1, cursor: { id: query.cursor } } : {}),
        orderBy: { createdAt: "desc" },
        include: {
          source: { select: { name: true } },
          instance: { select: { id: true, name: true } },
        },
      });
      const canReadResults =
        principal.kind === "user" || principal.scopes.includes("results:read");
      return {
        data: rows.map((job) =>
          canReadResults ? job : { ...job, result: undefined },
        ),
        nextCursor: rows.length === 50 ? rows.at(-1)?.id : null,
      };
    },
  );

  app.get(
    "/jobs/:jobId",
    { preHandler: requireScope("jobs:read") },
    async (request, reply) => {
      const { jobId } = request.params as { jobId: string };
      const principal = request.principal!;
      const job = await prisma.job.findFirst({
        where: {
          id: jobId,
          tenantId: principal.tenantId,
          ...(principal.instanceId ? { instanceId: principal.instanceId } : {}),
        },
        include: {
          source: true,
          instance: { select: { id: true, name: true } },
          attemptsLog: { orderBy: { attempt: "asc" } },
        },
      });
      if (!job) return fail(reply, 404, "JOB_NOT_FOUND", "Job não encontrado.");
      if (
        principal.kind === "api-token" &&
        !principal.scopes.includes("results:read")
      )
        return { job: { ...job, result: undefined } };
      return { job };
    },
  );

  app.get(
    "/jobs/:jobId/artifacts/:artifactId",
    { preHandler: requireScope("results:read") },
    async (request, reply) => {
      const { jobId, artifactId } = request.params as {
        jobId: string;
        artifactId: string;
      };
      const principal = request.principal!;
      const artifact = await prisma.artifact.findFirst({
        where: {
          id: artifactId,
          jobId,
          job: {
            tenantId: principal.tenantId,
            ...(principal.instanceId
              ? { instanceId: principal.instanceId }
              : {}),
          },
        },
      });
      if (!artifact)
        return fail(
          reply,
          404,
          "ARTIFACT_NOT_FOUND",
          "Arquivo não encontrado.",
        );
      const object = await getArtifactStream(artifact.objectKey);
      reply
        .header("content-type", object.ContentType ?? artifact.contentType)
        .header("content-length", String(artifact.sizeBytes))
        .header("cache-control", "private, no-store")
        .header(
          "content-disposition",
          `inline; filename="${artifact.fileName.replace(/[^a-zA-Z0-9._-]/g, "_")}"`,
        );
      return reply.send(object.Body as never);
    },
  );

  app.post(
    "/jobs/:jobId/cancel",
    { preHandler: authenticated() },
    async (request, reply) => {
      if (!(await mayManage(request, reply))) return;
      const { jobId } = request.params as { jobId: string };
      const result = await prisma.job.updateMany({
        where: {
          id: jobId,
          tenantId: tenantId(request),
          status: JobStatus.QUEUED,
        },
        data: { status: JobStatus.CANCELLED, finishedAt: new Date() },
      });
      if (!result.count)
        return fail(
          reply,
          409,
          "JOB_NOT_CANCELLABLE",
          "Job não encontrado ou já iniciado.",
        );
      await audit({
        tenantId: tenantId(request),
        actorUserId: auditActor(request),
        action: "job.cancelled",
        resourceType: "job",
        resourceId: jobId,
      });
      return { cancelled: true };
    },
  );

  app.post(
    "/instances/:instanceId/tokens",
    { preHandler: authenticated() },
    async (request, reply) => {
      if (!(await mayAdmin(request, reply))) return;
      const { instanceId } = request.params as { instanceId: string };
      if (!(await getInstance(request, instanceId)))
        return fail(
          reply,
          404,
          "INSTANCE_NOT_FOUND",
          "Instância não encontrada.",
        );
      const body = parsed(tokenCreateSchema, request.body, reply);
      if (!body) return;
      const raw = `sc_${randomToken(36)}`;
      const token = await prisma.apiToken.create({
        data: {
          instanceId,
          name: body.name,
          prefix: raw.slice(0, 11),
          tokenHash: sha256(raw),
          scopes: body.scopes,
          expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
        },
      });
      await audit({
        tenantId: tenantId(request),
        actorUserId: auditActor(request),
        action: "token.created",
        resourceType: "api-token",
        resourceId: token.id,
        metadata: { scopes: token.scopes },
      });
      return reply.code(201).send({
        token: {
          id: token.id,
          name: token.name,
          prefix: token.prefix,
          scopes: token.scopes,
          expiresAt: token.expiresAt,
          createdAt: token.createdAt,
        },
        secret: raw,
      });
    },
  );

  app.get(
    "/instances/:instanceId/tokens",
    { preHandler: authenticated() },
    async (request, reply) => {
      if (!(await mayAdmin(request, reply))) return;
      const { instanceId } = request.params as { instanceId: string };
      if (!(await getInstance(request, instanceId)))
        return fail(
          reply,
          404,
          "INSTANCE_NOT_FOUND",
          "Instância não encontrada.",
        );
      return {
        data: await prisma.apiToken.findMany({
          where: { instanceId, revokedAt: null },
          select: {
            id: true,
            name: true,
            prefix: true,
            scopes: true,
            expiresAt: true,
            lastUsedAt: true,
            createdAt: true,
          },
          orderBy: { createdAt: "desc" },
        }),
      };
    },
  );

  app.delete(
    "/tokens/:tokenId",
    { preHandler: authenticated() },
    async (request, reply) => {
      if (!(await mayAdmin(request, reply))) return;
      const { tokenId } = request.params as { tokenId: string };
      const update = await prisma.apiToken.updateMany({
        where: {
          id: tokenId,
          instance: { tenantId: tenantId(request) },
          revokedAt: null,
        },
        data: { revokedAt: new Date() },
      });
      if (!update.count)
        return fail(
          reply,
          404,
          "TOKEN_NOT_FOUND",
          "Token ativo não encontrado.",
        );
      await audit({
        tenantId: tenantId(request),
        actorUserId: auditActor(request),
        action: "token.revoked",
        resourceType: "api-token",
        resourceId: tokenId,
      });
      return reply.code(204).send();
    },
  );

  app.post(
    "/instances/:instanceId/schedules",
    { preHandler: authenticated() },
    async (request, reply) => {
      if (!(await mayManage(request, reply))) return;
      const { instanceId } = request.params as { instanceId: string };
      const instance = await getInstance(request, instanceId);
      if (!instance)
        return fail(
          reply,
          404,
          "INSTANCE_NOT_FOUND",
          "Instância não encontrada.",
        );
      const body = parsed(scheduleCreateSchema, request.body, reply);
      if (!body) return;
      const source = await prisma.source.findFirst({
        where: { id: body.sourceId, instanceId, enabled: true },
      });
      if (!source)
        return fail(
          reply,
          404,
          "SOURCE_NOT_FOUND",
          "Fonte ativa não encontrada nesta instância.",
        );
      let nextRunAt: Date;
      try {
        nextRunAt = CronExpressionParser.parse(body.cron, { tz: body.timezone })
          .next()
          .toDate();
      } catch {
        return fail(
          reply,
          400,
          "CRON_INVALID",
          "Expressão cron ou fuso horário inválido.",
        );
      }
      const schedule = await prisma.schedule.create({
        data: {
          tenantId: instance.tenantId,
          instanceId,
          sourceId: source.id,
          name: body.name,
          cron: body.cron,
          timezone: body.timezone,
          input: body.input as Prisma.InputJsonValue,
          nextRunAt,
        },
      });
      await audit({
        tenantId: tenantId(request),
        actorUserId: auditActor(request),
        action: "schedule.created",
        resourceType: "schedule",
        resourceId: schedule.id,
      });
      return reply.code(201).send({ schedule });
    },
  );

  app.get(
    "/instances/:instanceId/schedules",
    { preHandler: authenticated() },
    async (request, reply) => {
      const { instanceId } = request.params as { instanceId: string };
      if (!(await getInstance(request, instanceId)))
        return fail(
          reply,
          404,
          "INSTANCE_NOT_FOUND",
          "Instância não encontrada.",
        );
      return {
        data: await prisma.schedule.findMany({
          where: { instanceId, tenantId: tenantId(request) },
          orderBy: { nextRunAt: "asc" },
        }),
      };
    },
  );

  app.patch(
    "/schedules/:scheduleId",
    { preHandler: authenticated() },
    async (request, reply) => {
      if (!(await mayManage(request, reply))) return;
      const { scheduleId } = request.params as { scheduleId: string };
      const body = parsed(
        z.object({ enabled: z.boolean() }),
        request.body,
        reply,
      );
      if (!body) return;
      const update = await prisma.schedule.updateMany({
        where: { id: scheduleId, tenantId: tenantId(request) },
        data: body,
      });
      if (!update.count)
        return fail(
          reply,
          404,
          "SCHEDULE_NOT_FOUND",
          "Schedule não encontrado.",
        );
      return { updated: true };
    },
  );

  app.post(
    "/instances/:instanceId/webhooks",
    { preHandler: authenticated() },
    async (request, reply) => {
      if (!(await mayAdmin(request, reply))) return;
      const { instanceId } = request.params as { instanceId: string };
      const instance = await getInstance(request, instanceId);
      if (!instance)
        return fail(
          reply,
          404,
          "INSTANCE_NOT_FOUND",
          "Instância não encontrada.",
        );
      const body = parsed(webhookCreateSchema, request.body, reply);
      if (!body) return;
      let url: URL;
      try {
        url = await assertSafePublicUrl(
          body.url,
          [new URL(body.url).hostname.toLowerCase()],
          false,
        );
      } catch (error) {
        return fail(
          reply,
          400,
          "WEBHOOK_URL_BLOCKED",
          error instanceof Error ? error.message : "Destino não permitido.",
        );
      }
      if (url.protocol !== "https:")
        return fail(
          reply,
          400,
          "WEBHOOK_HTTPS_REQUIRED",
          "Webhooks exigem HTTPS.",
        );
      const secret = `whsec_${randomToken(32)}`;
      const webhook = await prisma.webhook.create({
        data: {
          tenantId: instance.tenantId,
          instanceId,
          name: body.name,
          url: url.toString(),
          events: body.events,
          secretEncrypted: encryptSecret(secret),
        },
      });
      await audit({
        tenantId: tenantId(request),
        actorUserId: auditActor(request),
        action: "webhook.created",
        resourceType: "webhook",
        resourceId: webhook.id,
        metadata: { events: webhook.events },
      });
      return reply.code(201).send({
        webhook: {
          id: webhook.id,
          name: webhook.name,
          url: webhook.url,
          events: webhook.events,
          enabled: webhook.enabled,
          createdAt: webhook.createdAt,
        },
        secret,
      });
    },
  );

  app.get(
    "/instances/:instanceId/webhooks",
    { preHandler: authenticated() },
    async (request, reply) => {
      if (
        !(await getInstance(
          request,
          (request.params as { instanceId: string }).instanceId,
        ))
      )
        return fail(
          reply,
          404,
          "INSTANCE_NOT_FOUND",
          "Instância não encontrada.",
        );
      const { instanceId } = request.params as { instanceId: string };
      return {
        data: await prisma.webhook.findMany({
          where: { tenantId: tenantId(request), instanceId },
          select: {
            id: true,
            name: true,
            url: true,
            events: true,
            enabled: true,
            createdAt: true,
          },
          orderBy: { createdAt: "desc" },
        }),
      };
    },
  );

  app.get(
    "/webhooks/:webhookId/deliveries",
    { preHandler: authenticated() },
    async (request, reply) => {
      const { webhookId } = request.params as { webhookId: string };
      const webhook = await prisma.webhook.findFirst({
        where: { id: webhookId, tenantId: tenantId(request) },
      });
      if (!webhook)
        return fail(reply, 404, "WEBHOOK_NOT_FOUND", "Webhook não encontrado.");
      return {
        data: await prisma.webhookDelivery.findMany({
          where: { webhookId },
          select: {
            id: true,
            eventType: true,
            status: true,
            attempts: true,
            nextAttemptAt: true,
            lastStatusCode: true,
            lastError: true,
            deliveredAt: true,
            createdAt: true,
          },
          orderBy: { createdAt: "desc" },
          take: 100,
        }),
      };
    },
  );

  app.get("/audit", { preHandler: authenticated() }, async (request, reply) => {
    if (!(await mayAdmin(request, reply))) return;
    const { cursor } = request.query as { cursor?: string };
    const data = await prisma.auditLog.findMany({
      where: { tenantId: tenantId(request) },
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      take: 100,
      orderBy: { createdAt: "desc" },
    });
    return { data, nextCursor: data.length === 100 ? data.at(-1)?.id : null };
  });

  app.get(
    "/ops/health",
    { preHandler: authenticated() },
    async (request, reply) => {
      if (!(await mayAdmin(request, reply))) return;
      const probes = await Promise.allSettled([
        prisma.$queryRaw`SELECT 1`,
        options.redis.ping(),
        (async () => {
          const connection = await connectAmqp(
            process.env.RABBITMQ_URL ?? "amqp://localhost:5672",
            { timeout: 2000 },
          );
          await connection.close();
        })(),
        checkObjectStorage(),
      ]);
      const names = ["postgres", "redis", "rabbitmq", "objectStorage"] as const;
      const dependencies = Object.fromEntries(
        names.map((name, index) => [
          name,
          probes[index]?.status === "fulfilled" ? "ok" : "unavailable",
        ]),
      );
      const failed = Object.values(dependencies).filter(
        (status) => status !== "ok",
      ).length;
      const [queuedJobs, failedJobs, activeJobs] = await Promise.all([
        prisma.job.count({
          where: { tenantId: tenantId(request), status: JobStatus.QUEUED },
        }),
        prisma.job.count({
          where: {
            tenantId: tenantId(request),
            status: JobStatus.FAILED,
            createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
          },
        }),
        prisma.job.count({
          where: { tenantId: tenantId(request), status: JobStatus.RUNNING },
        }),
      ]);
      return {
        status: failed === 0 ? "healthy" : "degraded",
        checkedAt: new Date().toISOString(),
        dependencies,
        activity: { queuedJobs, activeJobs, failedJobsLast24Hours: failedJobs },
        runtime: {
          version: process.env.SCOUT_VERSION ?? "0.3.0",
          uptimeSeconds: Math.floor(process.uptime()),
          memoryBytes: process.memoryUsage().rss,
          node: process.version,
        },
      };
    },
  );
}
