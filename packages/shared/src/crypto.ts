import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function encryptionKey(): Buffer {
  const encoded = process.env.SCOUT_ENCRYPTION_KEY_BASE64;
  if (!encoded) throw new Error("SCOUT_ENCRYPTION_KEY_BASE64 não configurada.");
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32)
    throw new Error(
      "SCOUT_ENCRYPTION_KEY_BASE64 deve codificar exatamente 32 bytes.",
    );
  return key;
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return [iv, cipher.getAuthTag(), ciphertext]
    .map((part) => part.toString("base64url"))
    .join(".");
}

export function decryptSecret(envelope: string): string {
  const [iv, tag, ciphertext] = envelope
    .split(".")
    .map((part) => Buffer.from(part, "base64url"));
  if (!iv || !tag || !ciphertext || iv.length !== 12 || tag.length !== 16)
    throw new Error("Envelope criptográfico inválido.");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString("utf8");
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}
