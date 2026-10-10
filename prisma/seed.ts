import "dotenv/config";
import argon2 from "argon2";
import { PrismaClient, TenantRole } from "@prisma/client";

const prisma = new PrismaClient();

// O bootstrap nunca deve criar outro OWNER ou alterar contas de uma instalação
// que já possua usuários. Uma conta existente é recuperada separadamente.
async function main(): Promise<void> {
  const existingUsers = await prisma.user.count();
  if (existingUsers > 0) {
    const email = process.env.SCOUT_BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
    const configuredUser = email
      ? await prisma.user.findUnique({
          where: { email },
          select: {
            id: true,
            isPlatformMaster: true,
            passwordHash: true,
            disabledAt: true,
            memberships: { select: { role: true } },
          },
        })
      : null;
    const password = process.env.SCOUT_BOOTSTRAP_ADMIN_PASSWORD;
    const matches =
      configuredUser && password
        ? await argon2
            .verify(configuredUser.passwordHash, password)
            .catch(() => false)
        : null;
    // Marca somente o OWNER identificado na configuração local da instalação.
    // Não altera credenciais, MFA, perfis ou dados existentes.
    if (
      configuredUser &&
      !configuredUser.isPlatformMaster &&
      configuredUser.memberships.some(
        (item) => item.role === TenantRole.OWNER,
      ) &&
      (await prisma.user.count({ where: { isPlatformMaster: true } })) === 0
    ) {
      await prisma.user.update({
        where: { id: configuredUser.id },
        data: { isPlatformMaster: true },
      });
    }
    process.stdout.write(
      [
        "Bootstrap preservado: banco de dados já contém usuários.",
        "Nenhuma senha, organização, permissão ou MFA foi alterada. A identidade principal pode ter recebido a marca de proteção.",
        `Conta configurada no .env: ${configuredUser ? "encontrada" : "não encontrada"}.`,
        `Senha do .env corresponde ao hash da conta: ${matches === null ? "não verificada" : matches ? "sim" : "não"}.`,
        `Conta habilitada: ${configuredUser ? (configuredUser.disabledAt ? "não" : "sim") : "não verificada"}.`,
        `Conta com papel OWNER: ${configuredUser ? (configuredUser.memberships.some((item) => item.role === TenantRole.OWNER) ? "sim" : "não") : "não verificada"}.`,
        "Para diagnosticar sem alterar dados, execute pnpm auth:diagnose.",
      ].join("\n") + "\n",
    );
    return;
  }

  const email = process.env.SCOUT_BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.SCOUT_BOOTSTRAP_ADMIN_PASSWORD;
  const name =
    process.env.SCOUT_BOOTSTRAP_ADMIN_NAME?.trim() || "Administrador";
  const tenantName =
    process.env.SCOUT_BOOTSTRAP_TENANT_NAME?.trim() || "Minha organização";
  const tenantSlug =
    process.env.SCOUT_BOOTSTRAP_TENANT_SLUG?.trim().toLowerCase() ||
    "minha-organizacao";

  if (
    !email ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    !password ||
    password.length < 16 ||
    password.length > 256 ||
    /^(replace|change)/i.test(password)
  ) {
    throw new Error(
      "Primeira instalação: defina SCOUT_BOOTSTRAP_ADMIN_EMAIL e uma senha inicial exclusiva de 16 a 256 caracteres no .env.",
    );
  }

  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  const created = await prisma.$transaction(async (tx) => {
    // Também confere dentro da transação; nunca atualiza contas existentes.
    if ((await tx.user.count()) > 0) return null;
    const tenant = await tx.tenant.upsert({
      where: { slug: tenantSlug },
      update: {},
      create: { name: tenantName, slug: tenantSlug },
    });
    const user = await tx.user.create({
      data: { email, name, passwordHash, isPlatformMaster: true },
    });
    await tx.membership.create({
      data: { tenantId: tenant.id, userId: user.id, role: TenantRole.OWNER },
    });
    return tenant.slug;
  });
  if (!created) {
    process.stdout.write(
      "Bootstrap ignorado: uma conta foi criada antes desta operação.\n",
    );
    return;
  }
  process.stdout.write(
    `Conta OWNER inicial criada na organização ${created}. Configure MFA no primeiro login.\n`,
  );
}

main().finally(async () => prisma.$disconnect());
