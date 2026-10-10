import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
let first = "";
let second = "";
describe("WhatsApp channel actions isolate workspaces", () => {
  beforeAll(async () => {
    first = (
      await prisma.tenant.create({
        data: { name: "Canal A", slug: "canal-a-" + randomUUID().slice(0, 8) },
      })
    ).id;
    second = (
      await prisma.tenant.create({
        data: { name: "Canal B", slug: "canal-b-" + randomUUID().slice(0, 8) },
      })
    ).id;
  });
  afterAll(async () => {
    await prisma.tenant.deleteMany({ where: { id: { in: [first, second] } } });
    await prisma.$disconnect();
  });
  it("enforces idempotency inside one space without blocking an unrelated space", async () => {
    const requestId = "action-" + randomUUID();
    const action = {
      remoteInstance: "remote-demo",
      kind: "STATUS",
      requestId,
      payloadHash: "a".repeat(64),
    };
    await prisma.channelAction.create({ data: { tenantId: first, ...action } });
    await expect(
      prisma.channelAction.create({ data: { tenantId: first, ...action } }),
    ).rejects.toMatchObject({ code: "P2002" });
    await expect(
      prisma.channelAction.create({ data: { tenantId: second, ...action } }),
    ).resolves.toMatchObject({ tenantId: second });
  });
  it("never includes other space's sending history in a scoped query", async () => {
    const records = await prisma.channelAction.findMany({
      where: { tenantId: first },
    });
    expect(records.length).toBeGreaterThan(0);
    expect(records.every((record) => record.tenantId === first)).toBe(true);
    expect(records.some((record) => record.tenantId === second)).toBe(false);
  });
});
