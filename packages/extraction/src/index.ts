import { load } from "cheerio";

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
      // A mídia original pertence ao link/cartão capturado. Preserva o
      // contrato anterior (href/text) e adiciona somente image_url opcional.
      const anchor = $(node);
      const thumbnail = anchor.find("img").first();
      const src =
        thumbnail.attr("data-src") ||
        thumbnail.attr("data-lazy-src") ||
        thumbnail.attr("src") ||
        thumbnail.attr("srcset")?.split(",")[0]?.trim().split(/\s+/)[0];
      const image_url =
        src && /^(https?:\/\/|\/\/|\/[^/])/i.test(src) && src.length <= 2048
          ? src
          : undefined;
      return {
        text: anchor.text().trim().slice(0, 1200),
        href: anchor.attr("href")?.slice(0, 2048) ?? "",
        ...(image_url ? { image_url } : {}),
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
