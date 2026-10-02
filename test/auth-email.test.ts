import { describe, expect, it } from "vitest";
import { recoverySmtpSettings } from "../apps/api/src/email.ts";
import { normalizeRecoveryCode } from "../apps/api/src/mfa.ts";

describe("separate SMTP responsibilities", () => {
  it("reads only the dedicated recovery relay configuration", () => {
    expect(
      recoverySmtpSettings({
        SMTP_HOST: "tenant.example.com",
        SMTP_PASSWORD: "tenant-secret",
      } as NodeJS.ProcessEnv),
    ).toBeNull();

    expect(
      recoverySmtpSettings({
        SCOUT_RECOVERY_SMTP_HOST: "recovery.example.com",
        SCOUT_RECOVERY_SMTP_FROM_EMAIL: "security@example.com",
        SCOUT_RECOVERY_SMTP_USERNAME: "recovery-user",
        SCOUT_RECOVERY_SMTP_PASSWORD: "recovery-secret",
      } as NodeJS.ProcessEnv),
    ).toMatchObject({
      host: "recovery.example.com",
      port: 587,
      secure: false,
      username: "recovery-user",
      password: "recovery-secret",
      fromEmail: "security@example.com",
    });
  });

  it("rejects partial recovery SMTP authentication credentials", () => {
    expect(() =>
      recoverySmtpSettings({
        SCOUT_RECOVERY_SMTP_HOST: "recovery.example.com",
        SCOUT_RECOVERY_SMTP_FROM_EMAIL: "security@example.com",
        SCOUT_RECOVERY_SMTP_USERNAME: "recovery-user",
      } as NodeJS.ProcessEnv),
    ).toThrow(/usuário e senha/i);
  });
});

describe("MFA recovery codes", () => {
  it("normalizes grouped codes and rejects values outside the code alphabet", () => {
    expect(normalizeRecoveryCode("a1B2-c3D4-e5F6-7890-AbCd")).toBe(
      "A1B2C3D4E5F67890ABCD",
    );
    expect(normalizeRecoveryCode("A1B2-C3D4-E5F6-7890-XXXX")).toBeNull();
    expect(normalizeRecoveryCode("123456")).toBeNull();
  });
});
