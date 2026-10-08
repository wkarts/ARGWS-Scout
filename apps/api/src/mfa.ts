import { randomBytes } from "node:crypto";
import { prisma } from "./db.ts";
import { sha256 } from "@argws/scout-shared/crypto";

export function normalizeRecoveryCode(value: string): string | null {
  const normalized = value.replace(/[\s-]/g, "").toUpperCase();
  return /^[A-F0-9]{20}$/.test(normalized) ? normalized : null;
}

export async function replaceRecoveryCodes(userId: string): Promise<string[]> {
  const codes = Array.from({ length: 10 }, () =>
    randomBytes(10)
      .toString("hex")
      .toUpperCase()
      .match(/.{1,4}/g)!
      .join("-"),
  );
  await prisma.$transaction(async (tx) => {
    await tx.mfaRecoveryCode.deleteMany({ where: { userId } });
    await tx.mfaRecoveryCode.createMany({
      data: codes.map((code) => ({
        userId,
        codeHash: recoveryCodeHash(userId, code),
      })),
    });
  });
  return codes;
}

export async function consumeRecoveryCode(
  userId: string,
  input: string,
): Promise<boolean> {
  const code = normalizeRecoveryCode(input);
  if (!code) return false;
  const result = await prisma.mfaRecoveryCode.updateMany({
    where: {
      userId,
      codeHash: recoveryCodeHash(userId, code),
      usedAt: null,
    },
    data: { usedAt: new Date() },
  });
  return result.count === 1;
}

function recoveryCodeHash(userId: string, code: string): string {
  return sha256(`${userId}:${code.replaceAll("-", "").toUpperCase()}`);
}
