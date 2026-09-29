import argon2 from "argon2";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  preHandlerHookHandler,
} from "fastify";
import { TenantRole } from "@prisma/client";
import { decryptSecret, randomToken, sha256 } from "@argws/scout-shared/crypto";
import { prisma } from "./db.ts";

export type Principal = {
  kind: "user" | "api-token";
  tenantId: string;
  userId?: string;
  role?: TenantRole;
  sessionId?: string;
  instanceId?: string;
  scopes: string[];
};

declare module "fastify" {
  interface FastifyRequest {
    principal: Principal | null;
  }
}

export function registerAuthTypes(app: FastifyInstance): void {
  app.decorateRequest("principal", null);
}

export async function requireAuth(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const bearer = request.headers.authorization?.replace(/^Bearer\s+/i, "");
  if (bearer?.startsWith("sc_")) {
    const token = await prisma.apiToken.findUnique({
      where: { tokenHash: sha256(bearer), revokedAt: null },
      include: { instance: true },
    });
    if (!token || (token.expiresAt && token.expiresAt <= new Date())) {
      reply.code(401).send({
        error: {
          code: "INVALID_API_TOKEN",
          message: "Token inválido ou expirado.",
        },
      });
      return;
    }
    request.principal = {
      kind: "api-token",
      tenantId: token.instance.tenantId,
      instanceId: token.instanceId,
      scopes: token.scopes,
    };
    void prisma.apiToken
      .update({ where: { id: token.id }, data: { lastUsedAt: new Date() } })
      .catch(() => undefined);
    return;
  }
  const access = bearer ?? request.cookies.scout_access;
  if (!access) {
    reply.code(401).send({
      error: { code: "AUTH_REQUIRED", message: "Autenticação necessária." },
    });
    return;
  }
  try {
    const claims = await request.server.jwt.verify<{
      type: string;
      tenantId: string;
      sessionId: string;
      sub: string;
    }>(access);
    if (
      claims.type !== "access" ||
      !claims.sessionId ||
      !claims.tenantId ||
      !claims.sub
    )
      throw new Error("Invalid access token.");
    const session = await prisma.authSession.findFirst({
      where: {
        id: claims.sessionId,
        userId: claims.sub,
        tenantId: claims.tenantId,
        revokedAt: null,
        expiresAt: { gt: new Date() },
        user: { disabledAt: null },
      },
    });
    const membership = await prisma.membership.findUnique({
      where: {
        tenantId_userId: { tenantId: claims.tenantId, userId: claims.sub },
      },
    });
    if (!session || !membership)
      throw new Error("Session revoked or membership removed.");
    request.principal = {
      kind: "user",
      tenantId: membership.tenantId,
      userId: membership.userId,
      role: membership.role,
      sessionId: session.id,
      scopes: ["*"],
    };
  } catch {
    reply.code(401).send({
      error: {
        code: "SESSION_INVALID",
        message: "Sessão inválida ou expirada.",
      },
    });
  }
}

export function authenticated(): preHandlerHookHandler {
  return requireAuth;
}

export function requireScope(scope: string): preHandlerHookHandler {
  return async (request, reply) => {
    if (!request.principal) await requireAuth(request, reply);
    if (reply.sent || !request.principal) return;
    const principal = request.principal;
    if (
      principal.kind === "api-token" &&
      !principal.scopes.includes(scope) &&
      !principal.scopes.includes("*")
    ) {
      reply.code(403).send({
        error: {
          code: "SCOPE_REQUIRED",
          message: `O token precisa do escopo ${scope}.`,
        },
      });
    }
  };
}

export function isManagerUser(request: FastifyRequest): boolean {
  return request.principal?.kind === "user";
}

export function hasRole(
  request: FastifyRequest,
  ...roles: TenantRole[]
): boolean {
  return (
    request.principal?.kind === "user" &&
    !!request.principal.role &&
    roles.includes(request.principal.role)
  );
}

export async function setSessionCookies(
  app: FastifyInstance,
  reply: FastifyReply,
  userId: string,
  tenantId: string,
  sessionId: string,
): Promise<void> {
  const secure = process.env.SCOUT_COOKIE_SECURE === "true";
  const refresh = app.jwt.sign(
    { type: "refresh", tenantId, nonce: randomToken(18) },
    { sub: userId, expiresIn: "30d", jti: sessionId },
  );
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  await prisma.authSession.update({
    where: { id: sessionId },
    data: { refreshHash: sha256(refresh), expiresAt },
  });
  const access = app.jwt.sign(
    { type: "access", tenantId, sessionId },
    { sub: userId, expiresIn: "15m" },
  );
  reply.setCookie("scout_access", access, {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/",
    maxAge: 900,
  });
  reply.setCookie("scout_refresh", refresh, {
    httpOnly: true,
    secure,
    sameSite: "strict",
    path: "/v1/auth",
    maxAge: 30 * 24 * 3600,
  });
}

export async function createSession(
  app: FastifyInstance,
  reply: FastifyReply,
  userId: string,
  tenantId: string,
): Promise<void> {
  const session = await prisma.authSession.create({
    data: {
      userId,
      tenantId,
      refreshHash: sha256(randomToken()),
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    },
  });
  await setSessionCookies(app, reply, userId, tenantId, session.id);
}

export async function verifyPreAuth(
  request: FastifyRequest,
): Promise<{ userId: string; tenantId: string }> {
  const bearer = request.headers.authorization?.replace(/^Bearer\s+/i, "");
  if (!bearer) throw new Error("Token de pré-autenticação ausente.");
  const claims = await request.server.jwt.verify<{
    type: string;
    tenantId: string;
    sub: string;
  }>(bearer);
  if (claims.type !== "preauth" || !claims.sub || !claims.tenantId)
    throw new Error("Token de pré-autenticação inválido.");
  return { userId: claims.sub, tenantId: claims.tenantId };
}

export async function verifyPassword(
  hash: string,
  password: string,
): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

export async function mfaSecret(userId: string): Promise<string | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { totpSecretEncrypted: true },
  });
  if (!user?.totpSecretEncrypted) return null;
  return decryptSecret(user.totpSecretEncrypted);
}

export function clearSessionCookies(reply: FastifyReply): void {
  const secure = process.env.SCOUT_COOKIE_SECURE === "true";
  reply.clearCookie("scout_access", { path: "/", secure, sameSite: "lax" });
  reply.clearCookie("scout_refresh", {
    path: "/v1/auth",
    secure,
    sameSite: "strict",
  });
}
