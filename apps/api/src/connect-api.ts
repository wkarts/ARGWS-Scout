import { safeRequest } from "@argws/scout-shared/url-policy";

export class ConnectApiError extends Error {
  constructor(
    message: string,
    readonly statusCode?: number,
  ) {
    super(message);
    this.name = "ConnectApiError";
  }
}

export type ConnectRemoteInstance = {
  name: string;
  integration: string;
  token?: string;
  connectionState?: string;
  number?: string;
  profileName?: string;
};

export function normalizeConnectBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new ConnectApiError("Informe uma URL válida para a Connect API.");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    trimmed.includes("?") ||
    trimmed.includes("#")
  )
    throw new ConnectApiError(
      "A Connect API deve usar HTTPS e não pode incluir credenciais, consulta ou fragmento na URL.",
    );
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

function endpointUrl(baseUrl: string, path: string): URL {
  const url = new URL(baseUrl);
  const separator = path.indexOf("?");
  const relativePath = separator < 0 ? path : path.slice(0, separator);
  const query = separator < 0 ? "" : path.slice(separator + 1);
  const prefix = url.pathname.replace(/\/+$/, "");
  url.pathname = `${prefix}/${relativePath.replace(/^\/+/, "")}`;
  if (query) url.search = query;
  return url;
}

export async function connectApiRequest<T>(
  input: {
    baseUrl: string;
    apiKey: string;
    path: string;
    method?: "GET" | "POST" | "DELETE";
    body?: Record<string, unknown>;
    timeoutMs?: number;
  },
  request: typeof safeRequest = safeRequest,
): Promise<T> {
  const baseUrl = normalizeConnectBaseUrl(input.baseUrl);
  if (!input.apiKey.trim())
    throw new ConnectApiError(
      "A chave administrativa da Connect API não está configurada.",
    );
  const url = endpointUrl(baseUrl, input.path);
  const response = await request(url.toString(), {
    allowedHosts: [url.hostname],
    method: input.method ?? "GET",
    headers: {
      apikey: input.apiKey,
      accept: "application/json",
      ...(input.body ? { "content-type": "application/json" } : {}),
    },
    ...(input.body ? { body: JSON.stringify(input.body) } : {}),
    timeoutMs: input.timeoutMs ?? 12000,
    maxBytes: 1024 * 1024,
    maxRedirects: 0,
  });
  if (response.status < 200 || response.status >= 300)
    throw new ConnectApiError(
      `A Connect API respondeu HTTP ${response.status}.`,
      response.status,
    );
  if (!response.body.byteLength) return undefined as T;
  try {
    return JSON.parse(response.body.toString("utf8")) as T;
  } catch {
    throw new ConnectApiError("A Connect API retornou uma resposta inválida.");
  }
}

export type WhatsAppPairingProvider = "WHATSAPP-BAILEYS" | "WHATSAPP-ZAPO";

export function createWhatsAppInstancePayload(
  name: string,
  token: string,
  integration: WhatsAppPairingProvider = "WHATSAPP-BAILEYS",
) {
  return {
    instanceName: name,
    integration,
    token,
    qrcode: true,
  };
}

/** QR remains independent of a phone pairing-code request. */
export function connectPairingPath(
  name: string,
  number: string,
): string {
  if (!/^[1-9]\d{7,14}$/.test(number))
    throw new ConnectApiError("Informe telefone internacional com DDI e DDD.");
  return connectInstancePath(name, "connect") + "?number=" + encodeURIComponent(number);
}

export function sendWhatsAppTextPayload(number: string, text: string) {
  return { number, text };
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function normalizeConnectInstances(
  value: unknown,
): ConnectRemoteInstance[] {
  const root = object(value);
  const rows = Array.isArray(value)
    ? value
    : Array.isArray(root?.instances)
      ? root.instances
      : Array.isArray(root?.data)
        ? root.data
        : Array.isArray(root?.instance)
          ? root.instance
          : root?.data && typeof root.data === "object"
            ? [root.data]
            : root?.instance && typeof root.instance === "object"
              ? [root.instance]
              : root && (root.name || root.instanceName)
                ? [root]
                : [];
  return rows.flatMap((row) => {
    const item = object(row);
    if (!item) return [];
    const name = String(item.name ?? item.instanceName ?? "").trim();
    if (!name) return [];
    const state = object(item.connectionStatus);
    const rawNumber = item.number ?? item.ownerJid ?? item.owner;
    const profile = item.profileName ?? item.name;
    return [
      {
        name,
        integration: String(item.integration ?? "WHATSAPP-BAILEYS"),
        ...(typeof item.token === "string" && item.token.length > 0
          ? { token: item.token }
          : {}),
        ...(typeof item.connectionState === "string"
          ? { connectionState: item.connectionState }
          : typeof state?.state === "string"
            ? { connectionState: state.state }
            : typeof item.connectionStatus === "string"
              ? { connectionState: item.connectionStatus }
              : {}),
        ...(typeof rawNumber === "string" && rawNumber.length <= 32
          ? { number: rawNumber.replace(/@.*$/, "") }
          : {}),
        ...(typeof profile === "string" && profile.length <= 120
          ? { profileName: profile }
          : {}),
      },
    ];
  });
}

export function connectInstancePath(name: string, action: string): string {
  return `/instance/${action}/${encodeURIComponent(name)}`;
}

export function connectSendTextPath(name: string): string {
  return `/message/sendText/${encodeURIComponent(name)}`;
}

export function isWhatsAppIntegration(integration: string): boolean {
  return ["WHATSAPP-BUSINESS", "WHATSAPP-BAILEYS", "WHATSAPP-ZAPO"].includes(
    integration.toUpperCase(),
  );
}

export function sanitizeConnectApiResponse(value: unknown, depth = 0): unknown {
  if (depth > 8) return undefined;
  if (Array.isArray(value))
    return value
      .slice(0, 500)
      .map((item) => sanitizeConnectApiResponse(item, depth + 1));
  const item = object(value);
  if (!item) return value;
  return Object.fromEntries(
    Object.entries(item)
      .filter(
        ([key]) =>
          !/(?:token|secret|password|authorization|api[_-]?key)/i.test(key),
      )
      .map(([key, child]) => [
        key,
        sanitizeConnectApiResponse(child, depth + 1),
      ])
      .filter(([, child]) => child !== undefined),
  );
}
