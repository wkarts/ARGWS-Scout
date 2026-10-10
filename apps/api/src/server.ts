import "dotenv/config";
import { buildVersion } from "./version.ts";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import jwt from "@fastify/jwt";
import rateLimit from "@fastify/rate-limit";
import Redis from "ioredis";
import { prisma } from "./db.ts";
import { registerAuthTypes } from "./auth.ts";
import { registerRoutes } from "./routes.ts";
import { validateEncryptionKey } from "@argws/scout-shared/crypto";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} não configurada.`);
  return value;
}

const jwtSecret = required("SCOUT_JWT_SECRET");
if (jwtSecret.length < 32 || jwtSecret.startsWith("replace-with"))
  throw new Error(
    "SCOUT_JWT_SECRET deve ter ao menos 32 caracteres aleatórios.",
  );
validateEncryptionKey();
const origins = (process.env.SCOUT_CORS_ORIGINS ?? "http://localhost:8080")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379/0", {
  maxRetriesPerRequest: 1,
  lazyConnect: true,
});
await redis.connect().catch((error: unknown) => {
  throw new Error(
    `Redis indisponível: ${error instanceof Error ? error.message : "falha de conexão"}`,
  );
});
const trustedProxyHops = Math.max(
  0,
  Number(process.env.SCOUT_TRUST_PROXY_HOPS ?? 1),
);

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? "info",
    redact: [
      "req.headers.authorization",
      "req.headers.cookie",
      "res.headers.set-cookie",
    ],
  },
  bodyLimit: 256 * 1024,
  trustProxy:
    trustedProxyHops > 0 ? (_address, hop) => hop < trustedProxyHops : false,
});

registerAuthTypes(app);
await app.register(cookie);
await app.register(cors, {
  origin: origins,
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
});
await app.register(helmet, {
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
});
await app.register(jwt, {
  secret: jwtSecret,
  sign: { iss: "argws-scout", aud: "argws-scout-client" },
  verify: { allowedIss: "argws-scout", allowedAud: "argws-scout-client" },
});
await app.register(rateLimit, { max: 120, timeWindow: "1 minute", redis });

app.addHook("onRequest", async (request, reply) => {
  if (!["POST", "PATCH", "PUT", "DELETE"].includes(request.method)) return;
  const origin = request.headers.origin;
  if (origin && !origins.includes(origin))
    return reply.code(403).send({
      error: { code: "ORIGIN_BLOCKED", message: "Origem não permitida." },
    });
});

app.get("/health/live", async () => ({
  status: "ok",
  service: "argws-scout-api",
  version: buildVersion,
}));
app.get("/health/ready", async (_request, reply) => {
  const checks = await Promise.allSettled([
    prisma.$queryRaw`SELECT 1`,
    redis.ping(),
  ]);
  const dependencies = {
    postgres: checks[0]?.status === "fulfilled" ? "ok" : "unavailable",
    redis: checks[1]?.status === "fulfilled" ? "ok" : "unavailable",
  };
  const ready = Object.values(dependencies).every((state) => state === "ok");
  return reply.code(ready ? 200 : 503).send({
    status: ready ? "ready" : "not_ready",
    dependencies,
  });
});

await app.register(registerRoutes, { prefix: "/v1", redis });
app.setNotFoundHandler((_request, reply) =>
  reply
    .code(404)
    .send({ error: { code: "NOT_FOUND", message: "Rota não encontrada." } }),
);
app.setErrorHandler((error: Error, request, reply) => {
  request.log.error({ name: error.name }, "Falha não tratada na API");
  if (reply.sent) return;
  return reply.code(500).send({
    error: {
      code: "INTERNAL_ERROR",
      message:
        "Erro interno. Use o identificador da requisição ao solicitar suporte.",
    },
    requestId: request.id,
  });
});

app.addHook("onClose", async () => {
  redis.disconnect();
  await prisma.$disconnect();
});
const port = Number(process.env.SCOUT_API_PORT ?? 8080);
await app.listen({ host: "0.0.0.0", port });
app.log.info({ port }, "ARGWS Scout API iniciada");
