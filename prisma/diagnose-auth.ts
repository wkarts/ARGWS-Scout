import "dotenv/config";
import argon2 from "argon2";
import { PrismaClient, TenantRole } from "@prisma/client";

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const email = process.env.SCOUT_BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.SCOUT_BOOTSTRAP_ADMIN_PASSWORD;
  const userCount = await prisma.user.count();
  const ownerMembershipCount = await prisma.membership.count({
    where: { role: TenantRole.OWNER },
  });
  const user = email
    ? await prisma.user.findUnique({
        where: { email },
        select: {
          passwordHash: true,
          disabledAt: true,
          mfaEnabled: true,
          memberships: {
            select: { role: true, tenant: { select: { slug: true } } },
          },
        },
      })
    : null;
  const passwordMatches =
    user && password
      ? await argon2.verify(user.passwordHash, password).catch(() => false)
      : null;

  // Não imprimir e-mail, senha, hashes, segredos TOTP nem tokens nos logs.
  const report = {
    totalUsers: userCount,
    ownerMembershipCount,
    bootstrapEmailConfigured: Boolean(email),
    bootstrapAccountFound: Boolean(user),
    bootstrapAccountEnabled: user ? user.disabledAt === null : null,
    bootstrapAccountOwner: user
      ? user.memberships.some((item) => item.role === TenantRole.OWNER)
      : null,
    bootstrapAccountTenants: user
      ? user.memberships.map((item) => ({
          slug: item.tenant.slug,
          role: item.role,
        }))
      : [],
    bootstrapPasswordMatchesStoredHash: passwordMatches,
    mfaEnabled: user ? user.mfaEnabled : null,
    recommendedAction:
      userCount === 0
        ? "Configurar .env e executar pnpm db:seed (ou reiniciar a stack corrigida)."
        : !user
          ? "A conta configurada não existe nesta base. Confira o e-mail ou recupere a conta OWNER existente."
          : passwordMatches === false
            ? "Senha divergente. Utilize a recuperação por e-mail ou pnpm auth:recover-owner no console seguro."
            : "Conta encontrada. Use as credenciais cadastradas e conclua a verificação MFA, quando exigida.",
  };
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}

main().finally(async () => prisma.$disconnect());
