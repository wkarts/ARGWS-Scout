import "dotenv/config";
import argon2 from "argon2";
import { PrismaClient, TenantRole } from "@prisma/client";

const prisma = new PrismaClient();

async function main(): Promise<void> {
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
    !password ||
    password.length < 16 ||
    password.startsWith("replace-with")
  ) {
    throw new Error(
      "Defina SCOUT_BOOTSTRAP_ADMIN_EMAIL e uma senha exclusiva de pelo menos 16 caracteres antes do seed.",
    );
  }
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  const tenant = await prisma.tenant.upsert({
    where: { slug: tenantSlug },
    update: {},
    create: { name: tenantName, slug: tenantSlug },
  });
  const user = await prisma.user.upsert({
    where: { email },
    update: { name },
    create: { email, name, passwordHash },
  });
  await prisma.membership.upsert({
    where: { tenantId_userId: { tenantId: tenant.id, userId: user.id } },
    update: { role: TenantRole.OWNER },
    create: { tenantId: tenant.id, userId: user.id, role: TenantRole.OWNER },
  });
  process.stdout.write(
    `Conta inicial verificada: ${email} · tenant ${tenant.slug}. Configure MFA no primeiro login.\n`,
  );
}

main().finally(async () => prisma.$disconnect());
