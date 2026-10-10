import argon2 from "argon2";
import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Prisma, TenantRole } from "@prisma/client";
import { z } from "zod";
import { randomToken, sha256 } from "@argws/scout-shared/crypto";
import { authenticated } from "./auth.ts";
import { prisma } from "./db.ts";
import { audit } from "./audit.ts";
import { sendTenantEmail, TenantSmtpNotConfiguredError } from "./email.ts";
import { isProtectedUser } from "./protected-user.ts";
import { createSession } from "./auth.ts";

const inviteSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(254),
  role: z.enum(["ADMIN", "OPERATOR", "VIEWER"]).default("VIEWER"),
  independentWorkspace: z.boolean().default(true),
  workspaceName: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().trim().min(2).max(120).optional(),
  ),
});
const tokenSchema = z.object({ token: z.string().min(32).max(128) });
const acceptSchema = tokenSchema.extend({
  password: z.string().min(16).max(256),
  name: z.string().trim().min(2).max(120).optional(),
});
const expiryMs = 48 * 60 * 60 * 1000;

function error(
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
) {
  return reply.code(status).send({ error: { code, message } });
}
function requiredAdmin(request: FastifyRequest, reply: FastifyReply): boolean {
  if (
    request.principal?.kind !== "user" ||
    !request.principal.role ||
    (request.principal.role !== TenantRole.OWNER &&
      request.principal.role !== TenantRole.ADMIN)
  ) {
    error(
      reply,
      403,
      "FORBIDDEN",
      "Somente administradores podem convidar pessoas.",
    );
    return false;
  }
  return true;
}
function normalize(email: string) {
  return email.trim().toLowerCase();
}
function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ] ?? character,
  );
}
function isUsable(invite: {
  acceptedAt: Date | null;
  revokedAt: Date | null;
  expiresAt: Date;
}): boolean {
  return (
    !invite.acceptedAt && !invite.revokedAt && invite.expiresAt > new Date()
  );
}

async function provisionIndependentSpace(
  tx: Prisma.TransactionClient,
  userId: string,
  label: string,
): Promise<string> {
  const safeName = label.trim().slice(0, 120) || "Meu espaço";
  const prefix =
    safeName
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 38) || "espaco";
  const space = await tx.tenant.create({
    data: {
      name: safeName,
      slug: prefix + "-" + randomBytes(8).toString("hex"),
    },
  });
  await tx.membership.create({
    data: { tenantId: space.id, userId, role: TenantRole.OWNER },
  });
  return space.id;
}

export async function registerInvitationRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.get(
    "/users/invitations",
    { preHandler: authenticated() },
    async (request, reply) => {
      if (!requiredAdmin(request, reply)) return;
      const invites = await prisma.userInvitation.findMany({
        where: {
          tenantId: request.principal!.tenantId,
          acceptedAt: null,
          revokedAt: null,
        },
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          independentWorkspace: true,
          workspaceName: true,
          expiresAt: true,
          createdAt: true,
        },
        orderBy: { createdAt: "desc" },
        take: 100,
      });
      return {
        data: invites.filter(
          (invite) =>
            !isProtectedUser({ email: invite.email, isPlatformMaster: false }),
        ),
      };
    },
  );

  app.post(
    "/users/invitations",
    {
      preHandler: authenticated(),
      config: { rateLimit: { max: 10, timeWindow: "1 hour" } },
    },
    async (request, reply) => {
      if (!requiredAdmin(request, reply)) return;
      const data = inviteSchema.safeParse(request.body);
      if (!data.success)
        return error(
          reply,
          400,
          "VALIDATION_ERROR",
          "Revise nome, e-mail e permissão.",
        );
      const name = data.data.name;
      const email = normalize(data.data.email);
      if (isProtectedUser({ email, isPlatformMaster: false }))
        return error(
          reply,
          403,
          "ACCOUNT_PROTECTED",
          "Esta identidade não pode receber convites.",
        );
      const existing = await prisma.user.findUnique({
        where: { email },
        select: { id: true, isPlatformMaster: true },
      });
      if (existing?.isPlatformMaster)
        return error(
          reply,
          403,
          "ACCOUNT_PROTECTED",
          "Esta identidade não pode receber convites.",
        );
      const existingMembership = existing
        ? await prisma.membership.findUnique({
            where: {
              tenantId_userId: {
                tenantId: request.principal!.tenantId,
                userId: existing.id,
              },
            },
          })
        : null;
      if (!data.data.independentWorkspace && existingMembership)
        return error(
          reply,
          409,
          "USER_EXISTS",
          "A pessoa já possui acesso a este espaço.",
        );
      const sender = await prisma.tenantSmtpConfig.findUnique({
        where: { tenantId: request.principal!.tenantId },
        select: { tenantId: true },
      });
      if (!sender)
        return error(
          reply,
          409,
          "SMTP_REQUIRED",
          "Configure o SMTP de envio em Configurações antes de convidar.",
        );
      const url = process.env.SCOUT_PUBLIC_URL?.trim();
      if (!url || !/^https?:\/\//.test(url))
        return error(
          reply,
          503,
          "PUBLIC_URL_REQUIRED",
          "Endereço público não configurado.",
        );
      const token = randomToken(48);
      const invitation = await prisma.$transaction(async (tx) => {
        await tx.userInvitation.updateMany({
          where: {
            tenantId: request.principal!.tenantId,
            email,
            acceptedAt: null,
            revokedAt: null,
          },
          data: { revokedAt: new Date() },
        });
        return tx.userInvitation.create({
          data: {
            tenantId: request.principal!.tenantId,
            invitedByUserId: request.principal!.userId!,
            name,
            email,
            role: data.data.independentWorkspace
              ? TenantRole.OWNER
              : (data.data.role as TenantRole),
            independentWorkspace: data.data.independentWorkspace,
            workspaceName: data.data.independentWorkspace
              ? (data.data.workspaceName ?? "Espaço de " + name).slice(0, 120)
              : null,
            tokenHash: sha256(token),
            expiresAt: new Date(Date.now() + expiryMs),
          },
        });
      });
      const link = url.replace(/\/$/, "") + "/#invite=" + token;
      try {
        await sendTenantEmail(request.principal!.tenantId, {
          to: email,
          subject: "Convite para acessar o Scout",
          text:
            "Olá, " +
            name +
            ".\n\nVocê recebeu um convite para acessar o Scout. Abra o link e ative sua conta em até 48 horas:\n" +
            link +
            "\n\nSe não esperava este convite, ignore esta mensagem.",
          html:
            "<p>Olá, " +
            escapeHtml(name) +
            '.</p><p>Você recebeu um convite para acessar o Scout.</p><p><a href="' +
            escapeHtml(link) +
            '">Aceitar convite</a></p><p>O convite expira em 48 horas. Se não o solicitou, ignore esta mensagem.</p>',
        });
      } catch (cause) {
        await prisma.userInvitation.updateMany({
          where: { id: invitation.id, acceptedAt: null },
          data: { revokedAt: new Date() },
        });
        request.log.warn(
          {
            reason:
              cause instanceof TenantSmtpNotConfiguredError
                ? "smtp_not_configured"
                : "smtp_send_failed",
          },
          "Invitation mail delivery failed",
        );
        return error(
          reply,
          502,
          "INVITATION_MAIL_FAILED",
          "Não foi possível enviar o convite. Confira a configuração SMTP.",
        );
      }
      await audit({
        tenantId: invitation.tenantId,
        actorUserId: request.principal!.userId,
        action: "user.invited",
        resourceType: "invitation",
        resourceId: invitation.id,
        metadata: { role: invitation.role },
      });
      return reply.code(201).send({
        invitation: {
          id: invitation.id,
          email,
          expiresAt: invitation.expiresAt,
        },
      });
    },
  );

  app.post(
    "/users/invitations/:id/revoke",
    { preHandler: authenticated() },
    async (request, reply) => {
      if (!requiredAdmin(request, reply)) return;
      const result = z
        .object({ id: z.string().uuid() })
        .safeParse(request.params);
      if (!result.success)
        return error(reply, 400, "VALIDATION_ERROR", "Convite inválido.");
      const changed = await prisma.userInvitation.updateMany({
        where: {
          id: result.data.id,
          tenantId: request.principal!.tenantId,
          acceptedAt: null,
          revokedAt: null,
        },
        data: { revokedAt: new Date() },
      });
      if (!changed.count)
        return error(
          reply,
          404,
          "INVITATION_NOT_FOUND",
          "Convite indisponível.",
        );
      await audit({
        tenantId: request.principal!.tenantId,
        actorUserId: request.principal!.userId,
        action: "user.invitation.revoked",
        resourceType: "invitation",
        resourceId: result.data.id,
      });
      return reply.code(204).send();
    },
  );

  app.post(
    "/auth/invitations/preview",
    {
      config: { rateLimit: { max: 15, timeWindow: "15 minutes" } },
    },
    async (request, reply) => {
      const body = tokenSchema.safeParse(request.body);
      if (!body.success)
        return error(
          reply,
          400,
          "TOKEN_REQUIRED",
          "Informe um convite válido.",
        );
      const invitation = await prisma.userInvitation.findUnique({
        where: { tokenHash: sha256(body.data.token) },
        include: { tenant: { select: { name: true } } },
      });
      if (!invitation || !isUsable(invitation))
        return error(
          reply,
          404,
          "INVITATION_EXPIRED",
          "Este convite expirou ou foi cancelado.",
        );
      const existing = await prisma.user.findUnique({
        where: { email: invitation.email },
        select: { id: true },
      });
      return {
        name: invitation.name,
        email: invitation.email,
        organization: invitation.independentWorkspace
          ? (invitation.workspaceName ?? "Meu espaço")
          : invitation.tenant.name,
        independentWorkspace: invitation.independentWorkspace,
        hasAccount: Boolean(existing),
        expiresAt: invitation.expiresAt,
      };
    },
  );

  app.post(
    "/auth/invitations/accept",
    {
      config: { rateLimit: { max: 5, timeWindow: "15 minutes" } },
    },
    async (request, reply) => {
      const body = acceptSchema.safeParse(request.body);
      if (!body.success)
        return error(
          reply,
          400,
          "VALIDATION_ERROR",
          "Informe convite e senha válida (mínimo de 16 caracteres).",
        );
      const invitation = await prisma.userInvitation.findUnique({
        where: { tokenHash: sha256(body.data.token) },
      });
      if (!invitation || !isUsable(invitation))
        return error(
          reply,
          404,
          "INVITATION_EXPIRED",
          "Este convite expirou ou foi cancelado.",
        );
      if (isProtectedUser({ email: invitation.email, isPlatformMaster: false }))
        return error(
          reply,
          403,
          "ACCOUNT_PROTECTED",
          "Este convite não está disponível.",
        );
      if (
        await prisma.user.findUnique({
          where: { email: invitation.email },
          select: { id: true },
        })
      )
        return error(
          reply,
          409,
          "EXISTING_ACCOUNT",
          "Esta conta já existe. Entre primeiro e aceite o convite conectado.",
        );
      try {
        const user = await prisma.$transaction(async (tx) => {
          const updated = await tx.userInvitation.updateMany({
            where: {
              id: invitation.id,
              acceptedAt: null,
              revokedAt: null,
              expiresAt: { gt: new Date() },
            },
            data: { acceptedAt: new Date() },
          });
          if (updated.count !== 1) throw new Error("INVITATION_EXPIRED");
          const created = await tx.user.create({
            data: {
              email: invitation.email,
              name: body.data.name ?? invitation.name,
              passwordHash: await argon2.hash(body.data.password, {
                type: argon2.argon2id,
              }),
            },
          });
          if (invitation.independentWorkspace) {
            await provisionIndependentSpace(
              tx,
              created.id,
              invitation.workspaceName ?? "Meu espaço",
            );
          } else {
            await tx.membership.create({
              data: {
                tenantId: invitation.tenantId,
                userId: created.id,
                role: invitation.role,
              },
            });
          }
          return created;
        });
        await audit({
          tenantId: invitation.tenantId,
          actorUserId: user.id,
          action: "user.invitation.accepted",
          resourceType: "user",
          resourceId: user.id,
        });
        return reply.code(201).send({ activated: true, email: user.email });
      } catch (cause) {
        if (
          cause instanceof Prisma.PrismaClientKnownRequestError &&
          cause.code === "P2002"
        )
          return error(
            reply,
            409,
            "EXISTING_ACCOUNT",
            "Esta conta já existe. Entre para aceitar o convite.",
          );
        return error(
          reply,
          409,
          "INVITATION_EXPIRED",
          "Não foi possível ativar este convite. Solicite outro.",
        );
      }
    },
  );

  app.post(
    "/users/invitations/accept-existing",
    { preHandler: authenticated() },
    async (request, reply) => {
      if (request.principal?.kind !== "user")
        return error(
          reply,
          403,
          "USER_REQUIRED",
          "Entre para aceitar este convite.",
        );
      const data = tokenSchema.safeParse(request.body);
      if (!data.success)
        return error(reply, 400, "TOKEN_REQUIRED", "Convite inválido.");
      const invitation = await prisma.userInvitation.findUnique({
        where: { tokenHash: sha256(data.data.token) },
      });
      const user = await prisma.user.findUnique({
        where: { id: request.principal.userId! },
        select: { id: true, email: true, isPlatformMaster: true },
      });
      if (!invitation || !isUsable(invitation))
        return error(reply, 404, "INVITATION_EXPIRED", "Convite expirado.");
      if (
        !user ||
        isProtectedUser(user) ||
        normalize(user.email) !== invitation.email
      )
        return error(
          reply,
          403,
          "INVITATION_FORBIDDEN",
          "Este convite pertence a outra conta.",
        );
      const membership = invitation.independentWorkspace
        ? null
        : await prisma.membership.findUnique({
            where: {
              tenantId_userId: {
                tenantId: invitation.tenantId,
                userId: user.id,
              },
            },
          });
      if (
        invitation.independentWorkspace &&
        process.env.SCOUT_MFA_REQUIRED_FOR_OWNER !== "false"
      ) {
        const security = await prisma.user.findUnique({
          where: { id: user.id },
          select: { mfaEnabled: true },
        });
        if (!security?.mfaEnabled)
          return error(
            reply,
            409,
            "MFA_REQUIRED",
            "Ative a verificação em duas etapas no seu perfil antes de assumir um espaço próprio.",
          );
      }
      if (membership)
        return error(
          reply,
          409,
          "USER_EXISTS",
          "Você já participa deste espaço.",
        );
      try {
        const targetSpaceId = await prisma.$transaction(async (tx) => {
          const claim = await tx.userInvitation.updateMany({
            where: {
              id: invitation.id,
              acceptedAt: null,
              revokedAt: null,
              expiresAt: { gt: new Date() },
            },
            data: { acceptedAt: new Date() },
          });
          if (claim.count !== 1) throw new Error("expired");
          if (invitation.independentWorkspace) {
            return await provisionIndependentSpace(
              tx,
              user.id,
              invitation.workspaceName ?? "Meu espaço",
            );
          }
          await tx.membership.create({
            data: {
              tenantId: invitation.tenantId,
              userId: user.id,
              role: invitation.role,
            },
          });
          return invitation.tenantId;
        });
        await createSession(app, reply, user.id, targetSpaceId);
        await audit({
          tenantId: invitation.tenantId,
          actorUserId: user.id,
          action: "user.invitation.accepted_existing",
          resourceType: "user",
          resourceId: user.id,
        });
        return { activated: true, email: user.email };
      } catch {
        return error(
          reply,
          409,
          "INVITATION_EXPIRED",
          "Convite já utilizado ou não está disponível.",
        );
      }
    },
  );

  app.get(
    "/profile/spaces",
    { preHandler: authenticated() },
    async (request, reply) => {
      if (request.principal?.kind !== "user")
        return error(reply, 403, "USER_REQUIRED", "Acesso indisponível.");
      const memberships = await prisma.membership.findMany({
        where: { userId: request.principal.userId! },
        select: {
          tenantId: true,
          role: true,
          tenant: { select: { name: true } },
        },
        orderBy: { createdAt: "asc" },
      });
      return {
        data: memberships.map((m) => ({
          id: m.tenantId,
          name: m.tenant.name,
          role: m.role,
          current: m.tenantId === request.principal!.tenantId,
        })),
      };
    },
  );

  app.post(
    "/profile/spaces/switch",
    { preHandler: authenticated() },
    async (request, reply) => {
      if (request.principal?.kind !== "user")
        return error(reply, 403, "USER_REQUIRED", "Acesso indisponível.");
      const body = z
        .object({ spaceId: z.string().uuid() })
        .safeParse(request.body);
      if (!body.success)
        return error(
          reply,
          400,
          "VALIDATION_ERROR",
          "Selecione uma organização válida.",
        );
      const membership = await prisma.membership.findUnique({
        where: {
          tenantId_userId: {
            tenantId: body.data.spaceId,
            userId: request.principal.userId!,
          },
        },
      });
      if (!membership)
        return error(
          reply,
          403,
          "SPACE_FORBIDDEN",
          "Você não possui acesso a esta organização.",
        );
      await createSession(
        app,
        reply,
        request.principal.userId!,
        body.data.spaceId,
      );
      if (request.principal.sessionId)
        await prisma.authSession.updateMany({
          where: { id: request.principal.sessionId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      return { switched: true };
    },
  );
}
