import { describe, expect, it } from "vitest";
import { extractHtml } from "../packages/extraction/src/index.ts";
import { contentSettings } from "../packages/core/src/content-settings.ts";

describe("refinamento sem mudar a coleta original", () => {
  it("captura metadados JSON-LD, Open Graph e imagem de link", () => {
    const data = extractHtml(`<!doctype html><title>Catálogo</title>
      <meta property="og:image" content="https://cdn.example.org/og.jpg">
      <script type="application/ld+json">{"@type":"Product","name":"Câmera","offers":{"price":"20"}}</script>
      <body><a href="/produto/1"><img src="https://cdn.example.org/foto.jpg">Câmera R$ 20,00</a></body>`);
    expect(data.title).toBe("Catálogo");
    expect((data.links as Array<{href:string;image_url?:string}>)[0]?.image_url).toBe("https://cdn.example.org/foto.jpg");
    expect((data.openGraph as {image:string}).image).toBe("https://cdn.example.org/og.jpg");
    expect((data.structuredData as unknown[]).length).toBe(1);
  });
  it("mantém refinamento e download de imagens desativados por padrão", () => {
    const cfg = contentSettings({});
    expect(cfg.autoProcess).toBe(false);
    expect(cfg.fetchImages).toBe(false);
    expect(cfg.enrichImages).toBe(false);
    expect(contentSettings({content:{autoProcess:true,maxItems:900}}).maxItems).toBe(250);
  });
});
