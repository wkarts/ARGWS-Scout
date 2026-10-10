import { describe, expect, it } from "vitest";
import { isProtectedUser } from "../apps/api/src/protected-user.ts";

describe("plataforma: proteção da conta principal", () => {
  it("protege a conta marcada no banco mesmo sem o endereço do ambiente", () => {
    expect(
      isProtectedUser(
        { email: "master@empresa.test", isPlatformMaster: true },
        undefined,
      ),
    ).toBe(true);
  });

  it("identifica o e-mail principal configurado mesmo antes da migração do registro", () => {
    expect(
      isProtectedUser(
        { email: "master@empresa.test", isPlatformMaster: false },
        "MASTER@empresa.test",
      ),
    ).toBe(true);
  });

  it("não confunde contas comuns com a identidade principal", () => {
    expect(
      isProtectedUser(
        { email: "admin@empresa.test", isPlatformMaster: false },
        "master@empresa.test",
      ),
    ).toBe(false);
  });

  it("não aceita comparação parcial de e-mails", () => {
    expect(
      isProtectedUser(
        { email: "outromaster@empresa.test", isPlatformMaster: false },
        "master@empresa.test",
      ),
    ).toBe(false);
  });
});
