import "dotenv/config";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import argon2 from "argon2";
import { PrismaClient, TenantRole } from "@prisma/client";

const prisma = new PrismaClient();

async function readHidden(label: string): Promise<string> {
  if (!stdin.isTTY || !stdout.isTTY || !stdin.setRawMode)
    throw new Error("A recuperação exige console interativo (TTY), nunca -T.");

  return new Promise<string>((resolve, reject) => {
    let value = "";
    const previousRaw = stdin.isRaw ?? false;
    stdout.write(label);
    const cleanup = () => {
      stdin.off("data", onData);
      stdin.setRawMode(previousRaw);
      stdout.write("\n");
    };
    const onData = (buffer: Buffer) => {
      for (const char of buffer.toString("utf8")) {
        if (char === "\u0003" || char === "\u0004") {
          cleanup();
          reject(new Error("Operação cancelada."));
          return;
        }
        if (char === "\r" || char === "\n") {
          cleanup();
          resolve(value);
          return;
        }
        if (char === "\u007f" || char === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        if (char >= " " && value.length < 256) value += char;
      }
    };
    stdin.setRawMode(true);
    stdin.on("data", onData);
    stdin.resume();
  });
}

async function main(): Promise<void> {
  if (!stdin.isTTY || !stdout.isTTY)
    throw new Error("Execute este comando apenas via console interativo da VPS.");
  const email = (
    process.env.SCOUT_AUTH_RECOVERY_EMAIL ??
    process.env.SCOUT_BOOTSTRAP_ADMIN_EMAIL ??
    ""
  )
    .trim()
    .toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    throw new Error("Informe SCOUT_BOOTSTRAP_ADMIN_EMAIL ou SCOUT_AUTH_RECOVERY_EMAIL.");
  const user = await prisma.user.findUnique({
    where: { email },
    select: {
      id: true,
      disabledAt: true,
      memberships: { select: { role: true } },
    },
  });
  if (
    !user ||
    user.disabledAt ||
    !user.memberships.some((item) => item.role === TenantRole.OWNER)
  )
    throw new Error("A conta informada não é uma conta OWNER ativa.");

  const rl = createInterface({ input: stdin, output: stdout });
  let confirmation: string;
  try {
    confirmation = await rl.question(
      "Redefinir a senha de uma conta OWNER, revogando sessões, sem desativar MFA. Digite REDEFINIR para confirmar: ",
    );
  } finally {
    rl.close();
  }
  if (confirmation.trim() !== "REDEFINIR")
    throw new Error("Recuperação cancelada. Nenhuma alteração realizada.");

  const password = await readHidden("Nova senha (16 a 256 caracteres, oculta): ");
  if (
    password.length < 16 ||
    password.length > 256 ||
    /^(replace|change)/i.test(password)
  )
    throw new Error("A senha deve conter de 16 a 256 caracteres e não pode ser um placeholder.");
  const again = await readHidden("Confirme a nova senha (oculta): ");
  if (password !== again)
    throw new Error("Senhas diferentes. Nenhuma alteração realizada.");

  const hash = await argon2.hash(password, { type: argon2.argon2id });
  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: user.id }, data: { passwordHash: hash } });
    await tx.authSession.updateMany({
      where: { userId: user.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await tx.passwordResetToken.updateMany({
      where: { userId: user.id, usedAt: null },
      data: { usedAt: new Date() },
    });
  });
  stdout.write(
    "Senha redefinida, sessões anteriores revogadas. MFA e permissões foram preservadas.\n",
  );
}

main()
  .catch((error: unknown) => {
    process.stderr.write(
      `Recuperação não concluída: ${error instanceof Error ? error.message : "erro"}\n`,
    );
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
