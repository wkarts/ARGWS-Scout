import { load } from "cheerio";

/**
 * Escolhe a URL da fotografia presente no HTML capturado, sem requisitar mídia.
 * Preferência por srcsets/originais lazy load; nunca usa placeholders, ícones
 * ou imagens base64 como uma suposta fotografia de produto.
 */
function imageUrl(value: string | undefined): string | undefined {
  const raw = value?.trim();
  if (
    !raw ||
    raw.length > 2048 ||
    !/^(https?:\/\/|\/\/|\/[^/])/i.test(raw) ||
    /(?:placeholder|no[-_]?image|sprite|spinner|loading|blank\.|\/pixel[./]|\.svg(?:[?#]|$))/i.test(raw)
  )
    return undefined;
  return raw;
}

function lastSrcset(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const candidates = value
    .split(",")
    .map((entry) => entry.trim().split(/\s+/)[0])
    .filter(Boolean);
  // A maioria dos sites publica srcset em ordem crescente de resolução.
  return candidates.length ? imageUrl(candidates[candidates.length - 1]) : undefined;
}

export function extractHtml(
  html: string,
  selector?: string,
): Record<string, unknown> {
  const $ = load(html);
  // Metadados estruturados são obtidos ANTES da limpeza. Nunca executados.
  // Limites impedem que JSON-LD enorme sobrecarregue o Job armazenado.
  const structuredData = $('script[type*="ld+json"]')
    .slice(0, 12)
    .map((_index, node) => {
      const raw = $(node).html() ?? "";
      if (!raw || raw.length > 120_000) return null;
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        return null;
      }
    })
    .get()
    .filter((value): value is unknown => value != null);
  const openGraph = {
    title:
      $('meta[property="og:title"]').attr("content")?.slice(0, 500) ?? null,
    description:
      $('meta[property="og:description"]').attr("content")?.slice(0, 2000) ??
      null,
    image:
      (
        $('meta[property="og:image:secure_url"]').attr("content") ||
        $('meta[property="og:image"]').attr("content") ||
        $('meta[name="twitter:image"]').attr("content")
      )?.slice(0, 2048) ?? null,
    url: $('meta[property="og:url"]').attr("content")?.slice(0, 2048) ?? null,
  };
  $("script,style,noscript,template,iframe,object,embed").remove();
  const title = $("title").first().text().trim().slice(0, 500);
  const description =
    $('meta[name="description"]').attr("content")?.trim().slice(0, 2000) ??
    null;
  const headings = $("h1,h2,h3")
    .slice(0, 100)
    .map((_index, node) => $(node).text().trim().slice(0, 500))
    .get()
    .filter(Boolean);

  const links = $("a[href]")
    .slice(0, 600)
    .map((_index, node) => {
      const anchor = $(node);
      const href = anchor.attr("href")?.slice(0, 2048) ?? "";
      // Preserva href/text, adicionando somente image_url ao link correto.
      const photoIn = (scope: typeof anchor): string | undefined => {
        for (const node of scope.find("img").slice(0, 12).toArray()) {
          const img = $(node);
          const width = Number(img.attr("width") || 0);
          const height = Number(img.attr("height") || 0);
          if ((width > 0 && width <= 2) || (height > 0 && height <= 2))
            continue;
          const candidates = [
            imageUrl(img.attr("data-zoom-image")),
            imageUrl(img.attr("data-original")),
            imageUrl(img.attr("data-src")),
            imageUrl(img.attr("data-lazy-src")),
            imageUrl(img.attr("data-image")),
            lastSrcset(img.attr("data-srcset")),
            lastSrcset(img.attr("srcset")),
            lastSrcset(img.parent("picture").find("source").first().attr("srcset")),
            imageUrl(img.attr("src")),
          ];
          const found = candidates.find(Boolean);
          if (found) return found;
        }
        return undefined;
      };
      let photo = photoIn(anchor);
      // E-commerces com foto e descrição em links irmãos: procura apenas no
      // cartão que contém exatamente um destino de produto, nunca na lista toda.
      if (!photo && /\/(?:produto|product|products|item|listing|p|dp)\/|\/MLB-\d+/i.test(href)) {
        const card = anchor.closest(
          "article, li, [data-testid*='product'], [data-testid*='Product'], " +
            "[class*='product-card'], [class*='productCard'], [class*='ProductCard'], " +
            "[class*='product-item']",
        );
        if (card.length) {
          const targets = new Set(
            card
              .find("a[href]")
              .toArray()
              .map((link) => $(link).attr("href")?.split("?")[0])
              .filter((link): link is string =>
                Boolean(link && /\/(?:produto|product|products|item|listing|p|dp)\/|\/MLB-\d+/i.test(link)),
              ),
          );
          if (targets.size === 1 && targets.has(href.split("?")[0] ?? ""))
            photo = photoIn(card as typeof anchor);
        }
      }
      return {
        text: anchor.text().trim().slice(0, 1200),
        href,
        ...(photo ? { image_url: photo } : {}),
      };
    })
    .get();
  const selected = selector
    ? $(selector)
        .slice(0, 200)
        .map((_index, node) => $(node).text().trim().slice(0, 2000))
        .get()
    : [];
  const text = $("body").text().replace(/\s+/g, " ").trim().slice(0, 12000);
  return {
    title,
    description,
    headings,
    links,
    text,
    selected,
    structuredData,
    openGraph,
  };
}

export function extractJson(value: unknown, path?: string): unknown {
  if (!path) return value;
  return path.split(".").reduce<unknown>((current, key) => {
    if (current && typeof current === "object")
      return (current as Record<string, unknown>)[key];
    return undefined;
  }, value);
}
