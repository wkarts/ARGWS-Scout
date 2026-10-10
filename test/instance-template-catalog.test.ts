import { describe, expect, it } from "vitest";
import { sourceCreateSchema } from "../packages/schemas/src/index.ts";
import {
  STARTER_TEMPLATES,
  getStarterTemplate,
  listStarterTemplates,
  buildTemplateSource,
  templateInstanceSlug,
} from "../apps/api/src/instance-templates.ts";

describe("catálogo de modelos de coleta", () => {
  it("oferece modelos com IDs únicos, incluindo os marketplaces solicitados", () => {
    const ids = STARTER_TEMPLATES.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining([
      "mercado-livre", "shopee", "amazon", "magalu", "aliexpress", "kabum", "olx",
      "buscape", "ebay", "website",
    ]));
    expect(STARTER_TEMPLATES.length).toBeGreaterThanOrEqual(10);
  });
  it("gera uma fonte válida para cada modelo, sem criar jobs ou executar coleta", () => {
    for (const item of STARTER_TEMPLATES) {
      const source = buildTemplateSource(item, item.sampleQuery);
      expect(sourceCreateSchema.safeParse(source).success, item.id).toBe(true);
      const url = new URL(source.url);
      expect(url.protocol).toBe("https:");
      expect(source.allowedHosts).toContain(url.hostname);
      expect(source.respectRobots).toBe(true);
      expect(source.requestIntervalMs).toBeGreaterThanOrEqual(5000);
      expect(source.name.length).toBeGreaterThan(1);
    }
  });
  it("permite ajustar a busca, motor e seletor sem alterar o modelo original", () => {
    const original = getStarterTemplate("amazon")!;
    const source = buildTemplateSource(original, "livro sobre Laravel", {
      engine: "PLAYWRIGHT",
      selector: "h1",
      requestIntervalMs: 25000,
    });
    expect(new URL(source.url).searchParams.get("k")).toBe("livro sobre Laravel");
    expect(source.engine).toBe("PLAYWRIGHT");
    expect(source.selector).toBe("h1");
    expect(source.requestIntervalMs).toBe(25000);
    expect(original.engine).toBe("HTTP");
  });
  it("nunca desabilita robots.txt automaticamente ao clonar", () => {
    const source = buildTemplateSource(getStarterTemplate("mercado-livre")!, "fone", {
      respectRobots: false,
    });
    expect(source.respectRobots).toBe(true);
  });
  it("aceita um URL personalizado com hostname recalculado e bloqueia allowlist divergente", () => {
    const template = getStarterTemplate("website")!;
    const source = buildTemplateSource(template, "teste", {
      url: "https://example.com/custom",
      selector: "h2",
    });
    expect(source.allowedHosts).toEqual(["example.com"]);
    expect(() => buildTemplateSource(template, "teste", {
      url: "https://example.com/custom", allowedHosts: ["another.example.com"],
    })).toThrow();
  });
  it("produz catálogo serializável e slugs seguros para múltiplas cópias", () => {
    const list = listStarterTemplates();
    expect(list.every((item) => typeof item.sampleUrl === "string")).toBe(true);
    expect(JSON.stringify(list)).not.toContain("buildUrl");
    const slugA = templateInstanceSlug("Pesquisa São Paulo", "aabbccdd");
    const slugB = templateInstanceSlug("Pesquisa São Paulo", "aabbccee");
    expect(slugA).toBe("pesquisa-sao-paulo-aabbccdd");
    expect(slugB).not.toBe(slugA);
    expect(slugA.length).toBeLessThanOrEqual(63);
  });
});
