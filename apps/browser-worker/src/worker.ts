import "dotenv/config";
import amqp from "amqplib";
import { QUEUES, type JobEnvelope } from "@argws/scout-core";
import { SourceEngine } from "@prisma/client";
import { createBrowser, runBrowser } from "@argws/scout-engine-playwright";
import { closeWorker, executeJob } from "@argws/scout-worker/execute-job";

const url = process.env.RABBITMQ_URL;
if (!url) throw new Error("RABBITMQ_URL não configurada.");
const browser = await createBrowser();
const connection = await amqp.connect(url);
const channel = await connection.createChannel();
await channel.assertQueue(QUEUES.browser, { durable: true });
await channel.prefetch(
  Math.max(1, Number(process.env.SCOUT_BROWSER_CONCURRENCY ?? 1)),
);
await channel.consume(
  QUEUES.browser,
  async (message) => {
    if (!message) return;
    let envelope: JobEnvelope;
    try {
      envelope = JSON.parse(message.content.toString()) as JobEnvelope;
      if (!envelope.jobId || !envelope.tenantId)
        throw new Error("Envelope inválido.");
    } catch {
      channel.ack(message);
      return;
    }
    try {
      await executeJob(envelope, SourceEngine.PLAYWRIGHT, (context) =>
        runBrowser(context, browser),
      );
      channel.ack(message);
    } catch (error) {
      process.stderr.write(
        `Browser Worker: ${error instanceof Error ? error.message : "falha"}\n`,
      );
      await new Promise((resolve) => setTimeout(resolve, 2000));
      channel.nack(message, false, true);
    }
  },
  { noAck: false },
);
process.stdout.write("ARGWS Scout Browser Worker pronto.\n");

async function shutdown(): Promise<void> {
  await channel.close().catch(() => undefined);
  await connection.close().catch(() => undefined);
  await browser.close().catch(() => undefined);
  await closeWorker();
  process.exit(0);
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
connection.on("close", () => process.exit(1));
