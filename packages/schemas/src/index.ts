import { z } from "zod";

export const slugSchema = z
  .string()
  .trim()
  .min(2)
  .max(63)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
export const roleSchema = z.enum(["OWNER", "ADMIN", "OPERATOR", "VIEWER"]);
export const engineSchema = z.enum(["HTTP", "PLAYWRIGHT"]);
export const jobStatusSchema = z.enum([
  "QUEUED",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
]);
export const inputSchema = z.record(z.unknown()).default({});

export const loginSchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(1).max(256),
  tenantSlug: slugSchema.optional(),
});

export const mfaCodeSchema = z.object({ code: z.string().regex(/^\d{6}$/) });

export const instanceCreateSchema = z.object({
  name: z.string().trim().min(2).max(120),
  slug: slugSchema.optional(),
  description: z.string().trim().max(500).optional(),
  metadata: z.record(z.unknown()).default({}),
});

const hostSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(253)
  .regex(
    /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
  );

export const sourceCreateSchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    engine: engineSchema,
    url: z.string().url().max(2048),
    allowedHosts: z.array(hostSchema).min(1).max(20),
    selector: z.string().trim().max(500).optional(),
    respectRobots: z.boolean().default(true),
    captureScreenshot: z.boolean().default(false),
    requestIntervalMs: z.number().int().min(1000).max(300000).default(5000),
  })
  .superRefine((source, ctx) => {
    try {
      const url = new URL(source.url);
      if (url.username || url.password)
        ctx.addIssue({
          code: "custom",
          path: ["url"],
          message: "Credenciais não podem estar embutidas na URL.",
        });
      if (!source.allowedHosts.includes(url.hostname.toLowerCase()))
        ctx.addIssue({
          code: "custom",
          path: ["allowedHosts"],
          message: "Inclua o hostname da URL na allowlist.",
        });
    } catch {
      ctx.addIssue({ code: "custom", path: ["url"], message: "URL inválida." });
    }
  });

export const jobCreateSchema = z.object({
  sourceId: z.string().uuid(),
  input: inputSchema,
});
export const scheduleCreateSchema = z.object({
  sourceId: z.string().uuid(),
  name: z.string().trim().min(2).max(120),
  cron: z.string().trim().min(9).max(100),
  timezone: z.string().trim().min(1).max(80).default("America/Bahia"),
  input: inputSchema,
});
export const tokenCreateSchema = z.object({
  name: z.string().trim().min(2).max(120),
  scopes: z
    .array(
      z.enum([
        "instances:read",
        "sources:read",
        "jobs:create",
        "jobs:read",
        "results:read",
      ]),
    )
    .min(1)
    .max(5),
  expiresAt: z.string().datetime().optional(),
});
export const webhookCreateSchema = z.object({
  name: z.string().trim().min(2).max(120),
  url: z.string().url().max(2048),
  events: z
    .array(z.enum(["job.completed", "job.failed"]))
    .min(1)
    .max(2),
});
export const profileUpdateSchema = z.object({
  name: z.string().trim().min(2).max(120),
  profile: z.record(z.unknown()).default({}),
});

export type Engine = z.infer<typeof engineSchema>;
export type SourceCreateInput = z.infer<typeof sourceCreateSchema>;
export type Role = z.infer<typeof roleSchema>;
