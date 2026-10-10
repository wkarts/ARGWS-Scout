import { describe, expect, it } from "vitest";
import {
  connectPairingPath,
  createWhatsAppInstancePayload,
} from "../apps/api/src/connect-api.ts";

describe("Connect|API WhatsApp pairing contracts", () => {
  it("creates Baileys by default without breaking existing clients", () => {
    expect(createWhatsAppInstancePayload("personal", "scoped-secret")).toEqual({
      instanceName: "personal",
      integration: "WHATSAPP-BAILEYS",
      token: "scoped-secret",
      qrcode: true,
    });
  });
  it("creates a native Zapo instance without substituting Baileys", () => {
    expect(
      createWhatsAppInstancePayload("zapo", "scoped-token", "WHATSAPP-ZAPO"),
    ).toEqual({
      instanceName: "zapo",
      integration: "WHATSAPP-ZAPO",
      token: "scoped-token",
      qrcode: true,
    });
  });
  it("requests a fresh pairing code via the native Connect endpoint with a number", () => {
    expect(connectPairingPath("sc-a-demo", "5575988881111")).toBe(
      "/instance/connect/sc-a-demo?number=5575988881111",
    );
    expect(connectPairingPath("teste WhatsApp", "5575988881111")).toBe(
      "/instance/connect/teste%20WhatsApp?number=5575988881111",
    );
  });
  it("rejects incomplete numbers before requesting a pairing code", () => {
    expect(() =>
      connectPairingPath("my-instance", "75988881111"),
    ).not.toThrow();
    expect(() => connectPairingPath("my-instance", "123")).toThrow(
      /telefone internacional/i,
    );
    expect(() => connectPairingPath("my-instance", "+5575988881111")).toThrow();
  });
});
