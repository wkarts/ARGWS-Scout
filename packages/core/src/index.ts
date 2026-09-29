import type { Engine } from "@argws/scout-schemas";

export const QUEUES = {
  http: "scout.jobs.http",
  browser: "scout.jobs.browser",
  webhooks: "scout.webhooks",
} as const;

export type JobEnvelope = { jobId: string; tenantId: string; engine: Engine };
export type WebhookEnvelope = { deliveryId: string };
export type ScoutSourceConfig = {
  url: string;
  allowedHosts: string[];
  selector?: string;
  respectRobots: boolean;
  captureScreenshot: boolean;
};

export type ConnectorContext = {
  input: Record<string, unknown>;
  source: ScoutSourceConfig;
  signal?: AbortSignal;
};

export type ConnectorResult = {
  requestedUrl: string;
  finalUrl: string;
  statusCode: number;
  contentType: string;
  data: Record<string, unknown>;
  capturedAt: string;
};

export function renderInputTemplate(
  template: string,
  input: Record<string, unknown>,
): string {
  return template.replace(
    /\{\{input\.([a-zA-Z0-9_.-]+)\}\}/g,
    (_match, path: string) => {
      const value = path.split(".").reduce<unknown>((current, key) => {
        if (!current || typeof current !== "object") return undefined;
        return (current as Record<string, unknown>)[key];
      }, input);
      if (value === undefined || value === null || typeof value === "object")
        throw new Error(`Campo input inválido: ${path}`);
      return encodeURIComponent(String(value));
    },
  );
}
