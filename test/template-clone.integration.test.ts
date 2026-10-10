import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTemplateSource, getStarterTemplate, templateInstanceSlug } from "../apps/api/src/instance-templates.ts";

const prisma = new PrismaClient();
const ids: string[] = [];

describe("Cópias de modelos por espaço de trabalho", () => {
  beforeAll(async () => {
    const one = await prisma.tenant.create({
      data: { name: "Modelos Equipe A", slug: "tpl-a-" + randomUUID().slice(0, 11) },
    });
    const two = await prisma.tenant.create({
      data: { name: "Modelos Equipe B", slug: "tpl-b-" + randomUUID().slice(0, 11) },
    });
    ids.push(one.id, two.id);
  });
  afterAll(async () => {
    if (ids.length) await prisma.tenant.deleteMany({ where: { id: { in: ids } } });
    await prisma.$disconnect();
  });
  it("cria registros independentes de instância e fonte em cada organização", async () => {
    const template = getStarterTemplate("amazon")!;
    const prepared = buildTemplateSource(template, "notebook");
    const instances = await Promise.all(ids.map((tenantId) => prisma.instance.create({
      data: {
        tenantId,
        name: "Comparação Amazon",
        slug: templateInstanceSlug("Comparação Amazon"),
        metadata: { starterTemplate: { id: template.id, version: 1 } },
        sources: {
          create: {
            name: prepared.name, engine: prepared.engine, urlTemplate: prepared.url,
            allowedHosts: prepared.allowedHosts, selector: prepared.selector,
            respectRobots: prepared.respectRobots,
            captureScreenshot: prepared.captureScreenshot,
            requestIntervalMs: prepared.requestIntervalMs,
          },
        },
      },
      include: { sources: true },
    })));
    expect(instances[0]!.id).not.toBe(instances[1]!.id);
    expect(instances[0]!.sources[0]!.id).not.toBe(instances[1]!.sources[0]!.id);
    const own = await prisma.instance.findMany({ where: { tenantId: ids[0] } });
    expect(own.some((instance) => instance.id === instances[0]!.id)).toBe(true);
    expect(own.some((instance) => instance.id === instances[1]!.id)).toBe(false);
  });
});
