import "dotenv/config";
import { createHmac } from "node:crypto";
import amqp from "amqplib";
import { PrismaClient } from "@prisma/client";
import { QUEUES, type WebhookEnvelope } from "@argws/scout-core";
import { decryptSecret } from "@argws/scout-shared/crypto";
import { safeRequest } from "@argws/scout-shared/url-policy";

const prisma = new PrismaClient();
const rabbitUrl = process.env.RABBITMQ_URL;
if (!rabbitUrl) throw new Error("RABBITMQ_URL não configurada.");
const connection = await amqp.connect(rabbitUrl);
const channel = await connection.createChannel();
await channel.assertQueue(QUEUES.webhooks, { durable: true });
await channel.prefetch(
  Math.max(1, Number(process.env.SCOUT_WEBHOOK_CONCURRENCY ?? 4)),
);
const maxAttempts = Number(process.env.SCOUT_WEBHOOK_MAX_ATTEMPTS ?? 8);

async function deliver(deliveryId: string): Promise<void> {
  const claimed = await prisma.webhookDelivery.updateMany({
    where: { id: deliveryId, status: "PENDING" },
    data: {
      status: "SENDING",
      leaseUntil: new Date(Date.now() + 60_000),
      attempts: { increment: 1 },
    },
  });
  if (!claimed.count) return;
  const delivery = await prisma.webhookDelivery.findUnique({
    where: { id: deliveryId },
    include: { webhook: true },
  });
  if (!delivery) return;
  const attempt = delivery.attempts;
  try {
    if (!delivery.webhook.enabled) throw new Error("Webhook desativado.");
    const rawBody = JSON.stringify({
      id: delivery.eventId,
      type: delivery.eventType,
      createdAt: delivery.createdAt.toISOString(),
      data: delivery.payload,
    });
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const host = new URL(delivery.webhook.url).hostname.toLowerCase();
    const secret = decryptSecret(delivery.webhook.secretEncrypted);
    const signature = createHmac("sha256", secret)
      .update(`${timestamp}.${rawBody}`)
      .digest("hex");
    const response = await safeRequest(delivery.webhook.url, {
      allowedHosts: [host],
      method: "POST",
      body: rawBody,
      headers: {
        "content-type": "application/json",
        "user-agent":
          process.env.SCOUT_WEBHOOK_USER_AGENT ?? "ARGWS-Scout-Webhook/0.1",
        "x-scout-webhook-id": delivery.eventId,
        "x-scout-webhook-timestamp": timestamp,
        "x-scout-webhook-signature": `sha256=${signature}`,
        "idempotency-key": delivery.eventId,
      },
      timeoutMs: 10000,
      maxBytes: 65536,
      maxRedirects: 2,
    });
    if (response.status < 200 || response.status >= 300)
      throw Object.assign(
        new Error(`Destino respondeu HTTP ${response.status}.`),
        {
          statusCode: response.status,
          excerpt: response.body.toString("utf8").slice(0, 500),
        },
      );
    await prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: {
        status: "SUCCEEDED",
        leaseUntil: null,
        lastStatusCode: response.status,
        responseExcerpt: response.body.toString("utf8").slice(0, 1000),
        lastError: null,
        deliveredAt: new Date(),
      },
    });
  } catch (error) {
    const retry = attempt < maxAttempts;
    const statusCode =
      typeof error === "object" && error !== null && "statusCode" in error
        ? Number(error.statusCode)
        : null;
    const excerpt =
      typeof error === "object" && error !== null && "excerpt" in error
        ? String(error.excerpt)
        : undefined;
    const message = (
      error instanceof Error ? error.message : "Falha de entrega"
    )
      .replace(/https?:\/\/[^\s"'<>]+/gi, "[URL]")
      .slice(0, 1000);
    await prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: {
        status: retry ? "PENDING" : "FAILED",
        leaseUntil: null,
        nextAttemptAt: retry
          ? new Date(
              Date.now() +
                Math.min(1_800_000, 3000 * 2 ** Math.min(attempt - 1, 9)),
            )
          : new Date(),
        lastStatusCode: statusCode,
        responseExcerpt: excerpt,
        lastError: message,
      },
    });
  }
}

await channel.consume(
  QUEUES.webhooks,
  async (message) => {
    if (!message) return;
    let deliveryId: string | undefined;
    try {
      const envelope = JSON.parse(
        message.content.toString(),
      ) as WebhookEnvelope;
      deliveryId = envelope.deliveryId;
      if (!deliveryId) throw new Error("Envelope inválido.");
      await deliver(deliveryId);
      channel.ack(message);
    } catch (error) {
      process.stderr.write(
        `Webhook Worker: ${error instanceof Error ? error.message : "falha"}\n`,
      );
      channel.ack(message);
    }
  },
  { noAck: false },
);
process.stdout.write("ARGWS Scout Webhook Worker pronto.\n");

async function shutdown(): Promise<void> {
  await channel.close().catch(() => undefined);
  await connection.close().catch(() => undefined);
  await prisma.$disconnect();
  process.exit(0);
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
