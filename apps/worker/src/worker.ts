import "dotenv/config";
import amqp from "amqplib";
import { QUEUES, type JobEnvelope } from "@argws/scout-core";
import { SourceEngine } from "@prisma/client";
import { runHttp } from "@argws/scout-engine-http";
import { closeWorker, executeJob } from "./execute-job.ts";

const url = process.env.RABBITMQ_URL;
if (!url) throw new Error("RABBITMQ_URL não configurada.");
const connection = await amqp.connect(url);
const channel = await connection.createChannel();
await channel.assertQueue(QUEUES.http, { durable: true });
await channel.prefetch(
  Math.max(1, Number(process.env.SCOUT_WORKER_CONCURRENCY ?? 2)),
);
await channel.consume(
  QUEUES.http,
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
      await executeJob(envelope, SourceEngine.HTTP, runHttp);
      channel.ack(message);
    } catch (error) {
      process.stderr.write(
        `Worker HTTP: ${error instanceof Error ? error.message : "falha"}\n`,
      );
      await new Promise((resolve) => setTimeout(resolve, 2000));
      channel.nack(message, false, true);
    }
  },
  { noAck: false },
);
process.stdout.write("ARGWS Scout HTTP Worker pronto.\n");

async function shutdown(): Promise<void> {
  await channel.close().catch(() => undefined);
  await connection.close().catch(() => undefined);
  await closeWorker();
  process.exit(0);
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
connection.on("close", () => process.exit(1));
