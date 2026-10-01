import { describe, expect, it } from "vitest";
import {
  connectInstancePath,
  isWhatsAppIntegration,
  normalizeConnectBaseUrl,
  normalizeConnectInstances,
  sanitizeConnectApiResponse,
} from "../apps/api/src/connect-api.ts";

describe("Connect API URL handling", () => {
  it("preserves a reverse-proxy path and removes trailing slashes", () => {
    expect(normalizeConnectBaseUrl("https://connect.example/api///")).toBe(
      "https://connect.example/api",
    );
  });

  it.each([
    "http://connect.example",
    "https://user:secret@connect.example",
    "https://connect.example?apikey=secret",
    "https://connect.example/#token",
  ])("rejects unsafe Connect API URL %s", (value) => {
    expect(() => normalizeConnectBaseUrl(value)).toThrow();
  });

  it("encodes a remote instance name in native API paths", () => {
    expect(connectInstancePath("Scout Sales", "connect")).toBe(
      "/instance/connect/Scout%20Sales",
    );
  });
});

describe("Connect API WhatsApp instance payloads", () => {
  it("normalizes a wrapped list without losing its per-instance token", () => {
    expect(
      normalizeConnectInstances({
        data: [
          {
            name: "Scout Sales",
            integration: "WHATSAPP-BAILEYS",
            token: "instance-only-token",
            connectionStatus: { state: "open" },
            ownerJid: "5575999999999@s.whatsapp.net",
          },
        ],
      }),
    ).toEqual([
      {
        name: "Scout Sales",
        integration: "WHATSAPP-BAILEYS",
        token: "instance-only-token",
        connectionState: "open",
        number: "5575999999999",
        profileName: "Scout Sales",
      },
    ]);
  });

  it("ignores nameless rows and recognizes WhatsApp providers only", () => {
    expect(
      normalizeConnectInstances([
        { id: "missing-name" },
        { instanceName: "WhatsApp", integration: "WHATSAPP-ZAPO" },
        { name: "Other", integration: "GOOGLE-FIND-HUB" },
      ])
        .filter((item) => isWhatsAppIntegration(item.integration))
        .map((item) => item.name),
    ).toEqual(["WhatsApp"]);
  });

  it("removes credentials from Connect API responses while keeping pairing data", () => {
    expect(
      sanitizeConnectApiResponse({
        pairingCode: "1234-5678",
        base64: "data:image/png;base64,qr",
        instance: {
          name: "Scout",
          token: "instance-secret",
          apiKey: "admin-secret",
        },
      }),
    ).toEqual({
      pairingCode: "1234-5678",
      base64: "data:image/png;base64,qr",
      instance: { name: "Scout" },
    });
  });
});
