import { afterEach, describe, expect, it } from "vitest";
import {
  decryptSecret,
  encryptSecret,
  validateEncryptionKey,
} from "../packages/shared/src/crypto.ts";

const originalKey = process.env.SCOUT_ENCRYPTION_KEY_BASE64;

afterEach(() => {
  if (originalKey === undefined) delete process.env.SCOUT_ENCRYPTION_KEY_BASE64;
  else process.env.SCOUT_ENCRYPTION_KEY_BASE64 = originalKey;
});

describe("Scout encryption configuration", () => {
  it("rejects deployment placeholders before Manager credentials are saved", () => {
    process.env.SCOUT_ENCRYPTION_KEY_BASE64 = "REPLACE_WITH_BASE64_32_BYTE_KEY";
    expect(() => validateEncryptionKey()).toThrow(
      "SCOUT_ENCRYPTION_KEY_BASE64 deve codificar exatamente 32 bytes.",
    );
  });

  it("accepts a generated 32-byte key and encrypts Connect API credentials", () => {
    process.env.SCOUT_ENCRYPTION_KEY_BASE64 = Buffer.alloc(32, 7).toString(
      "base64",
    );
    expect(() => validateEncryptionKey()).not.toThrow();
    const ciphertext = encryptSecret("connect-api-instance-token");
    expect(ciphertext).not.toContain("connect-api-instance-token");
    expect(decryptSecret(ciphertext)).toBe("connect-api-instance-token");
  });
});
