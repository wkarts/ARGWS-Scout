import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

const prisma = new PrismaClient();
const slugA = "claim-a-" + randomUUID().slice(0, 12);
const slugB = "claim-b-" + randomUUID().slice(0, 12);
let tenantA: string;
let tenantB: string;

describe("global Connect|API instance ownership", () => {
  beforeAll(async () => {
    const a = await prisma.tenant.create({ data: { name: "Espaço A", slug: slugA } });
    const b = await prisma.tenant.create({ data: { name: "Espaço B", slug: slugB } });
    tenantA = a.id;
    tenantB = b.id;
  });
  afterAll(async () => {
    await prisma.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB].filter(Boolean) } } });
    await prisma.$disconnect();
  });
  it("rejects assigning one global remote name to two distinct spaces", async () => {
    const name = "sc-aaaa-exclusive-test-" + randomUUID().slice(0, 8);
    await prisma.connectInstanceClaim.create({ data: { name, tenantId: tenantA } });
    await expect(prisma.connectInstanceClaim.create({
      data: { name, tenantId: tenantB },
    })).rejects.toMatchObject({ code: "P2002" });
  });
  it("returns only the claims owned by the queried workspace", async () => {
    const prefix = "sc-" + randomUUID().slice(0, 8);
    await prisma.connectInstanceClaim.create({ data: { name: prefix + "-a", tenantId: tenantA } });
    await prisma.connectInstanceClaim.create({ data: { name: prefix + "-b", tenantId: tenantB } });
    const own = await prisma.connectInstanceClaim.findMany({ where: { tenantId: tenantA } });
    const other = await prisma.connectInstanceClaim.findMany({ where: { tenantId: tenantB } });
    expect(own.map(x => x.name)).toContain(prefix + "-a");
    expect(own.map(x => x.name)).not.toContain(prefix + "-b");
    expect(other.map(x => x.name)).toContain(prefix + "-b");
    expect(other.map(x => x.name)).not.toContain(prefix + "-a");
  });
});
