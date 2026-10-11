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
    expect(
      (data.links as Array<{ href: string; image_url?: string }>)[0]?.image_url,
    ).toBe("https://cdn.example.org/foto.jpg");
    expect((data.openGraph as { image: string }).image).toBe(
      "https://cdn.example.org/og.jpg",
    );
    expect((data.structuredData as unknown[]).length).toBe(1);
  });
  it("associa srcset da galeria ao produto correto, mesmo fora do link textual", () => {
    const result = extractHtml(`<div class="catalog">
      <article class="product-card">
        <a href="/produto/1">Placa de vídeo modelo A R$ 1.099,00</a>
        <a href="/produto/1" aria-label="Foto da placa">
          <picture><source srcset="https://cdn.exemplo.com/a-350.webp 350w, https://cdn.exemplo.com/a-900.webp 900w">
          <img src="/placeholder.svg" alt="Placa modelo A"></picture>
        </a>
      </article>
      <article class="product-card">
        <a href="/produto/2">Placa de vídeo modelo B R$ 1.299,00</a>
        <img data-src="https://cdn.exemplo.com/b.webp" src="/loading.svg">
      </article>
    </div>`);
    const links = result.links as Array<{ href: string; image_url?: string }>;
    expect(links.find((x) => x.href === "/produto/1")?.image_url)
      .toBe("https://cdn.exemplo.com/a-900.webp");
    expect(links.find((x) => x.href === "/produto/2")?.image_url)
      .toBe("https://cdn.exemplo.com/b.webp");
  });
  it("não atribui fotos de outro produto ou placeholders ao link", () => {
    const result = extractHtml(`<article>
      <a href="/produto/1">Notebook primeiro</a>
      <a href="/produto/2">Notebook segundo</a>
      <img src="/placeholder.svg">
    </article>`);
    const links = result.links as Array<{ href: string; image_url?: string }>;
    expect(links[0].image_url).toBeUndefined();
    expect(links[1].image_url).toBeUndefined();
  });
  it("mantém refinamento e download de imagens desativados por padrão", () => {
    const cfg = contentSettings({});
    expect(cfg.autoProcess).toBe(false);
    expect(cfg.fetchImages).toBe(false);
    expect(cfg.enrichImages).toBe(false);
    expect(
      contentSettings({ content: { autoProcess: true, maxItems: 900 } })
        .maxItems,
    ).toBe(250);
  });
});
