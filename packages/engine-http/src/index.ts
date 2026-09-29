import type { ConnectorContext, ConnectorResult } from "@argws/scout-core";
import { extractHtml, extractJson } from "@argws/scout-extraction";
import {
  assertRobotsAllowed,
  safeRequest,
} from "@argws/scout-shared/url-policy";

export async function runHttp(
  context: ConnectorContext,
): Promise<ConnectorResult> {
  const allowHttp = process.env.SCOUT_ALLOW_HTTP === "true";
  if (context.source.respectRobots)
    await assertRobotsAllowed(context.source.url, context.source.allowedHosts);
  const response = await safeRequest(context.source.url, {
    allowedHosts: context.source.allowedHosts,
    timeoutMs: Number(process.env.SCOUT_HTTP_TIMEOUT_MS ?? 20000),
    maxBytes: Number(process.env.SCOUT_HTTP_MAX_BYTES ?? 2097152),
    allowHttp,
    headers: {
      "user-agent": "ARGWS-Scout/0.2 (+https://scout.argws.com.br/bot)",
      accept: "text/html,application/json,text/plain;q=0.9,*/*;q=0.1",
    },
  });
  const contentType = String(
    response.headers["content-type"] ?? "application/octet-stream",
  ).toLowerCase();
  if (!(
    contentType.includes("text/html") ||
    contentType.includes("application/json") ||
    contentType.startsWith("text/plain")
  )) {
    throw new Error(
      `Tipo de conteúdo não suportado: ${contentType.split(";")[0]}`,
    );
  }
  const content = response.body.toString("utf8");
  let data: Record<string, unknown>;
  if (contentType.includes("application/json")) {
    const parsed: unknown = JSON.parse(content);
    const selected = extractJson(
      parsed,
      typeof context.source.selector === "string"
        ? context.source.selector
        : undefined,
    );
    data = { value: selected };
  } else {
    data = extractHtml(content, context.source.selector);
  }
  return {
    requestedUrl: context.source.url,
    finalUrl: response.url,
    statusCode: response.status,
    contentType,
    data,
    capturedAt: new Date().toISOString(),
  };
}
