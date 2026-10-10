import { randomBytes } from "node:crypto";
import { normalizeConnectBaseUrl } from "./connect-api.ts";

export type GlobalConnectSettings = { baseUrl: string; apiKey: string };

/** Single server-owned administrative credential. Never return apiKey to clients. */
export function globalConnectSettings(
  env: NodeJS.ProcessEnv = process.env,
): GlobalConnectSettings | null {
  const rawUrl = env.SCOUT_CONNECT_API_URL?.trim() ?? "";
  const apiKey = env.SCOUT_CONNECT_API_TOKEN?.trim() ?? "";
  if (!rawUrl || !apiKey) return null;
  return { baseUrl: normalizeConnectBaseUrl(rawUrl), apiKey };
}

/** Global names must never collide between different workspaces on the shared Connect|API. */
export function remoteInstanceName(
  tenantId: string,
  displayName: string,
  nonce = randomBytes(4).toString("hex"),
): string {
  if (!/^[a-f0-9-]{36}$/i.test(tenantId) || !/^[a-f0-9]{8}$/i.test(nonce))
    throw new Error("Identificador inválido para instância.");
  const slug =
    displayName
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 42) || "canal";
  return `sc-${tenantId.replace(/-/g, "").slice(0, 12)}-${slug}-${nonce}`;
}
