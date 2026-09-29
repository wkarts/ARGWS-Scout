import "dotenv/config";
import { CronExpressionParser } from "cron-parser";
import { JobStatus, Prisma, PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const pollMs = Math.max(
  1000,
  Number(process.env.SCOUT_SCHEDULER_POLL_MS ?? 15000),
);
let running = true;

async function shutdown(): Promise<void> {
  running = false;
  await prisma.$disconnect();
  process.exit(0);
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

async function tick(): Promise<void> {
  const now = new Date();
  const due = await prisma.schedule.findMany({
    where: {
      enabled: true,
      nextRunAt: { lte: now },
      source: { enabled: true },
      instance: { enabled: true },
    },
    take: 100,
    orderBy: { nextRunAt: "asc" },
  });
  for (const schedule of due) {
    try {
      const nextRunAt = CronExpressionParser.parse(schedule.cron, {
        tz: schedule.timezone,
        currentDate: now,
      })
        .next()
        .toDate();
      await prisma.$transaction(async (tx) => {
        const claimed = await tx.schedule.updateMany({
          where: {
            id: schedule.id,
            enabled: true,
            nextRunAt: schedule.nextRunAt,
          },
          data: { nextRunAt, lastRunAt: now },
        });
        if (!claimed.count) return;
        const source = await tx.source.findFirst({
          where: { id: schedule.sourceId, enabled: true },
        });
        if (!source) return;
        const job = await tx.job.create({
          data: {
            tenantId: schedule.tenantId,
            instanceId: schedule.instanceId,
            sourceId: schedule.sourceId,
            input: schedule.input as Prisma.InputJsonValue,
            status: JobStatus.QUEUED,
          },
        });
        await tx.outbox.create({
          data: {
            tenantId: schedule.tenantId,
            eventType: "job.execute",
            routingKey: source.engine === "HTTP" ? "jobs.http" : "jobs.browser",
            aggregateId: job.id,
            payload: {
              jobId: job.id,
              tenantId: schedule.tenantId,
              engine: source.engine,
            },
          },
        });
      });
    } catch (error) {
      process.stderr.write(
        `Scheduler: schedule ${schedule.id}: ${error instanceof Error ? error.message : "falha"}\n`,
      );
    }
  }
}

while (running) {
  try {
    await tick();
  } catch (error) {
    process.stderr.write(
      `Scheduler: ${error instanceof Error ? error.message : "falha"}\n`,
    );
  }
  await new Promise((resolve) => setTimeout(resolve, pollMs));
}
