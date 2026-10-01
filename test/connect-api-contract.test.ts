import { describe, expect, it, vi } from "vitest";
import type { SafeRequestOptions } from "../packages/shared/src/url-policy.ts";
import {
  connectApiRequest,
  connectInstancePath,
  connectSendTextPath,
  createWhatsAppInstancePayload,
  normalizeConnectInstances,
  sendWhatsAppTextPayload,
} from "../apps/api/src/connect-api.ts";

describe("Connect API native WhatsApp contract", () => {
  it("uses the admin apikey header and preserves a reverse-proxy prefix", async () => {
    const response = [
      {
        name: "Scout Sales",
        integration: "WHATSAPP-BAILEYS",
        token: "instance-token",
        connectionStatus: "connecting",
        number: "5575999999999",
      },
    ];
    const request = vi.fn(async (url: string, options: SafeRequestOptions) => ({
      url,
      status: 200,
      headers: { "content-type": "application/json" },
      body: Buffer.from(JSON.stringify(response)),
    }));

    const payload = await connectApiRequest<unknown>(
      {
        baseUrl: "https://connect.example/connect/",
        apiKey: "connect-admin-key",
        path: "instance/fetchInstances",
      },
      request,
    );

    expect(request).toHaveBeenCalledWith(
      "https://connect.example/connect/instance/fetchInstances",
      expect.objectContaining({
        allowedHosts: ["connect.example"],
        method: "GET",
        headers: {
          apikey: "connect-admin-key",
          accept: "application/json",
        },
        maxRedirects: 0,
      }),
    );
    expect(normalizeConnectInstances(payload)).toEqual([
      {
        name: "Scout Sales",
        integration: "WHATSAPP-BAILEYS",
        token: "instance-token",
        connectionState: "connecting",
        number: "5575999999999",
        profileName: "Scout Sales",
      },
    ]);
  });

  it("creates Baileys instances with the Connect API field names", () => {
    expect(
      createWhatsAppInstancePayload("Scout Sales", "instance-token"),
    ).toEqual({
      instanceName: "Scout Sales",
      integration: "WHATSAPP-BAILEYS",
      token: "instance-token",
      qrcode: true,
    });
    expect(connectInstancePath("Scout Sales", "connect")).toBe(
      "/instance/connect/Scout%20Sales",
    );
    expect(connectInstancePath("Scout Sales", "delete")).toBe(
      "/instance/delete/Scout%20Sales",
    );
    expect(connectSendTextPath("Scout Sales")).toBe(
      "/message/sendText/Scout%20Sales",
    );
  });

  it("sends text with the native number and text fields", () => {
    expect(
      sendWhatsAppTextPayload("5575999999999", "Nova coleta disponível"),
    ).toEqual({ number: "5575999999999", text: "Nova coleta disponível" });
  });
});
