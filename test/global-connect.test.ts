import { describe, expect, it } from "vitest";
import { globalConnectSettings, remoteInstanceName } from "../apps/api/src/global-connect.ts";

describe("single global Connect|API configuration", () => {
  it("requires both URL and token without falling back to workspace credentials", () => {
    expect(globalConnectSettings({})).toBeNull();
    expect(globalConnectSettings({ SCOUT_CONNECT_API_URL: "https://connect.example" })).toBeNull();
    expect(globalConnectSettings({ SCOUT_CONNECT_API_TOKEN: "secret" })).toBeNull();
    expect(globalConnectSettings({
      SCOUT_CONNECT_API_URL: "https://connect.example/api/",
      SCOUT_CONNECT_API_TOKEN: "global-test-token",
    })).toEqual({ baseUrl: "https://connect.example/api", apiKey: "global-test-token" });
  });
  it("enforces HTTPS and rejects URL userinfo", () => {
    expect(() => globalConnectSettings({
      SCOUT_CONNECT_API_URL: "http://connect.example", SCOUT_CONNECT_API_TOKEN: "secret",
    })).toThrow(/HTTPS/);
    expect(() => globalConnectSettings({
      SCOUT_CONNECT_API_URL: "https://user:pass@connect.example", SCOUT_CONNECT_API_TOKEN: "secret",
    })).toThrow();
  });
  it("namespaces instances by workspace and keeps friendly labels outside the global name", () => {
    const a = "11111111-1111-4111-8111-111111111111";
    const b = "22222222-2222-4222-8222-222222222222";
    const first = remoteInstanceName(a, "WhatsApp Vendas", "a1b2c3d4");
    const second = remoteInstanceName(b, "WhatsApp Vendas", "a1b2c3d4");
    expect(first).toBe("sc-111111111111-whatsapp-vendas-a1b2c3d4");
    expect(second).toBe("sc-222222222222-whatsapp-vendas-a1b2c3d4");
    expect(first).not.toBe(second);
  });
  it("creates different remote names for two instances with the same label", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    expect(remoteInstanceName(id, "Suporte", "a1b2c3d4")).not.toBe(
      remoteInstanceName(id, "Suporte", "a1b2c3d5"),
    );
  });
});
