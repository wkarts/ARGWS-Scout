import { load } from "cheerio";

export function extractHtml(
  html: string,
  selector?: string,
): Record<string, unknown> {
  const $ = load(html);
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
    .slice(0, 200)
    .map((_index, node) => ({
      text: $(node).text().trim().slice(0, 250),
      href: $(node).attr("href")?.slice(0, 2048) ?? "",
    }))
    .get();
  const selected = selector
    ? $(selector)
        .slice(0, 200)
        .map((_index, node) => $(node).text().trim().slice(0, 2000))
        .get()
    : [];
  const text = $("body").text().replace(/\s+/g, " ").trim().slice(0, 12000);
  return { title, description, headings, links, text, selected };
}

export function extractJson(value: unknown, path?: string): unknown {
  if (!path) return value;
  return path.split(".").reduce<unknown>((current, key) => {
    if (current && typeof current === "object")
      return (current as Record<string, unknown>)[key];
    return undefined;
  }, value);
}
