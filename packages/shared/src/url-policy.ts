import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";
import robotsParser from "robots-parser";
import { Agent, request } from "undici";

export type SafeRequestOptions = {
  allowedHosts: string[];
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxBytes?: number;
  allowHttp?: boolean;
  maxRedirects?: number;
};

function publicAddress(address: string): boolean {
  try {
    const parsed = ipaddr.process(address);
    return parsed.range() === "unicast";
  } catch {
    return false;
  }
}

export async function assertSafePublicUrl(
  rawUrl: string,
  allowedHosts: string[],
  allowHttp = false,
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("URL inválida.");
  }
  if (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:"))
    throw new Error("A fonte deve usar HTTPS.");
  if (url.username || url.password)
    throw new Error("Credenciais na URL não são permitidas.");
  const hostname = url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (
    !allowedHosts
      .map((host) => host.toLowerCase().replace(/\.$/, ""))
      .includes(hostname)
  )
    throw new Error("Hostname fora da allowlist da fonte.");
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local")
  )
    throw new Error("Hostname local bloqueado.");
  if (isIP(hostname)) {
    if (!publicAddress(hostname))
      throw new Error("IP privado, reservado ou local bloqueado.");
    const allowedPorts = url.protocol === "https:" ? ["", "443"] : ["", "80"];
    if (!allowedPorts.includes(url.port))
      throw new Error("Porta não permitida.");
    return url;
  }
  const allowedPorts = url.protocol === "https:" ? ["", "443"] : ["", "80"];
  if (!allowedPorts.includes(url.port)) throw new Error("Porta não permitida.");
  const records = await lookup(hostname, { all: true, verbatim: true });
  if (
    !records.length ||
    records.some((record) => !publicAddress(record.address))
  )
    throw new Error("A fonte resolve para endereço privado ou reservado.");
  return url;
}

function secureLookup(
  hostname: string,
  options: { all?: boolean },
  callback: (...args: unknown[]) => void,
): void {
  lookup(hostname, { all: true, verbatim: true })
    .then((records) => {
      if (
        !records.length ||
        records.some((record) => !publicAddress(record.address))
      )
        throw new Error("Resolução DNS bloqueada por política SSRF.");
      if (options.all) callback(null, records);
      else callback(null, records[0]!.address, records[0]!.family);
    })
    .catch((error: unknown) => callback(error));
}

async function readLimited(
  body: AsyncIterable<Uint8Array>,
  maxBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of body) {
    size += chunk.byteLength;
    if (size > maxBytes)
      throw new Error(`Resposta ultrapassou o limite de ${maxBytes} bytes.`);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, size);
}

export async function safeRequest(
  rawUrl: string,
  options: SafeRequestOptions,
): Promise<{
  url: string;
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}> {
  const maxRedirects = options.maxRedirects ?? 3;
  const dispatcher = new Agent({ connect: { lookup: secureLookup as never } });
  let currentUrl = rawUrl;
  try {
    for (let redirect = 0; redirect <= maxRedirects; redirect++) {
      const url = await assertSafePublicUrl(
        currentUrl,
        options.allowedHosts,
        options.allowHttp ?? false,
      );
      const response = await request(url, {
        method: options.method ?? "GET",
        headers: options.headers,
        body: options.body,
        dispatcher,
        headersTimeout: options.timeoutMs ?? 20000,
        bodyTimeout: options.timeoutMs ?? 20000,
      });
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        const location = response.headers.location;
        await response.body.dump();
        if (!location || redirect === maxRedirects)
          throw new Error("Redirecionamento inválido ou acima do limite.");
        currentUrl = new URL(
          Array.isArray(location) ? location[0]! : location,
          url,
        ).toString();
        continue;
      }
      const contentLength = Number(response.headers["content-length"] ?? 0);
      const maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
      if (contentLength > maxBytes) {
        await response.body.dump();
        throw new Error("Resposta excede o limite de tamanho.");
      }
      const body = await readLimited(response.body, maxBytes);
      return {
        url: url.toString(),
        status: response.statusCode,
        headers: response.headers,
        body,
      };
    }
    throw new Error("Redirecionamento excedeu o limite.");
  } finally {
    await dispatcher.close();
  }
}

export async function assertRobotsAllowed(
  url: string,
  hosts: string[],
  timeoutMs = 10000,
): Promise<void> {
  const parsed = await assertSafePublicUrl(
    url,
    hosts,
    process.env.SCOUT_ALLOW_HTTP === "true",
  );
  const robotsUrl = new URL("/robots.txt", parsed.origin).toString();
  const response = await safeRequest(robotsUrl, {
    allowedHosts: hosts,
    timeoutMs,
    maxBytes: 512 * 1024,
    maxRedirects: 2,
    allowHttp: process.env.SCOUT_ALLOW_HTTP === "true",
  });
  if (response.status === 404) return;
  if (response.status < 200 || response.status >= 300)
    throw new Error(
      `Não foi possível validar robots.txt (HTTP ${response.status}).`,
    );
  const rules = robotsParser(robotsUrl, response.body.toString("utf8"));
  if (rules.isAllowed(parsed.toString(), "ARGWS-Scout") === false)
    throw new Error(
      "A URL está bloqueada pelas regras publicadas em robots.txt.",
    );
}
