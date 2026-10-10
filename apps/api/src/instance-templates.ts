import { randomBytes } from "node:crypto";
import type { SourceCreateInput } from "@argws/scout-schemas";
import { sourceCreateSchema } from "@argws/scout-schemas";

type Engine = "HTTP" | "PLAYWRIGHT";
type Category = "marketplaces" | "general";

export type StarterTemplate = Readonly<{
  id: string;
  title: string;
  provider: string;
  category: Category;
  description: string;
  sampleQuery: string;
  sourceName: string;
  engine: Engine;
  selector: string;
  requestIntervalMs: number;
  guidance: string;
  docsUrl?: string;
  buildUrl: (query: string) => string;
}>;

function searchUrl(origin: string, path: string, key: string, query: string): string {
  const url = new URL(path, origin);
  url.searchParams.set(key, query);
  return url.toString();
}

function searchSlug(query: string): string {
  return query.normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 90) || "produtos";
}

/**
 * Community-maintained starting configurations; no marketplace affiliation.
 * These are HTTP/HTML discovery presets, NOT authorized marketplace API integrations.
 * Layout changes, access controls and robots.txt may prevent some collections.
 */
export const STARTER_TEMPLATES: readonly StarterTemplate[] = [
  {
    id: "mercado-livre", title: "Mercado Livre", provider: "Mercado Livre",
    category: "marketplaces",
    description: "Pesquisa pública de anúncios e acompanhamento de produtos.",
    sampleQuery: "notebook", sourceName: "Resultados do Mercado Livre", engine: "HTTP",
    selector: ".ui-search-layout, .poly-card", requestIntervalMs: 15000,
    guidance: "Confira robots.txt e atualize os seletores quando o site mudar. A API oficial exige autorização para vários recursos.",
    docsUrl: "https://developers.mercadolivre.com.br/pt_br/itens-e-buscas",
    buildUrl: (query) => "https://lista.mercadolivre.com.br/" + searchSlug(query),
  },
  {
    id: "shopee", title: "Shopee", provider: "Shopee", category: "marketplaces",
    description: "Monitoramento inicial de páginas públicas de busca.",
    sampleQuery: "fone de ouvido", sourceName: "Resultados da Shopee", engine: "PLAYWRIGHT",
    selector: ".shopee-search-item-result, [data-sqe='item']", requestIntervalMs: 30000,
    guidance: "Páginas com JavaScript e restrições de acesso podem não carregar. Não automatize sessões privadas ou contorne verificações.",
    buildUrl: (query) => searchUrl("https://shopee.com.br", "/search", "keyword", query),
  },
  {
    id: "amazon", title: "Amazon Brasil", provider: "Amazon", category: "marketplaces",
    description: "Consulta inicial de resultados públicos da Amazon Brasil.",
    sampleQuery: "monitor", sourceName: "Busca na Amazon", engine: "HTTP",
    selector: "[data-component-type='s-search-result']", requestIntervalMs: 30000,
    guidance: "Não é integração com a Selling Partner API. APIs oficiais exigem credenciais e autorização; resultados HTML variam.",
    docsUrl: "https://developer-docs.amazon.com/sp-api/docs/connecting-to-the-selling-partner-api",
    buildUrl: (query) => searchUrl("https://www.amazon.com.br", "/s", "k", query),
  },
  {
    id: "magalu", title: "Magazine Luiza", provider: "Magalu", category: "marketplaces",
    description: "Busca inicial de ofertas e produtos no Magalu.",
    sampleQuery: "celular", sourceName: "Busca no Magalu", engine: "HTTP",
    selector: "[data-testid='product-card'], main article", requestIntervalMs: 20000,
    guidance: "Modelo HTML editável: confirme a rota de busca e os elementos na página pública antes de agendar.",
    buildUrl: (query) => "https://www.magazineluiza.com.br/busca/" + searchSlug(query) + "/",
  },
  {
    id: "aliexpress", title: "AliExpress", provider: "AliExpress", category: "marketplaces",
    description: "Pesquisa de produtos em páginas públicas do AliExpress.",
    sampleQuery: "smartwatch", sourceName: "Busca no AliExpress", engine: "HTTP",
    selector: ".search-card-item, .list--gallery--34TropR", requestIntervalMs: 30000,
    guidance: "O layout muda por localização e sessão; o modelo não acessa a conta do usuário.",
    buildUrl: (query) => "https://pt.aliexpress.com/w/wholesale-" + searchSlug(query) + ".html",
  },
  {
    id: "kabum", title: "KaBuM!", provider: "KaBuM!", category: "marketplaces",
    description: "Pesquisa de informática, periféricos e eletrônicos.",
    sampleQuery: "placa de video", sourceName: "Busca na KaBuM", engine: "HTTP",
    selector: "[data-testid='product-card'], main article", requestIntervalMs: 20000,
    guidance: "Revise seletores e política de acesso, especialmente em páginas renderizadas dinamicamente.",
    buildUrl: (query) => "https://www.kabum.com.br/busca/" + searchSlug(query),
  },
  {
    id: "olx", title: "OLX Brasil", provider: "OLX", category: "marketplaces",
    description: "Acompanhamento inicial de classificados publicados.",
    sampleQuery: "bicicleta", sourceName: "Classificados OLX", engine: "HTTP",
    selector: "[data-ds-component='DS-NewAdCard'], main article", requestIntervalMs: 30000,
    guidance: "Somente anúncios públicos e acesso autorizado. Respeite dados pessoais e limitações da plataforma.",
    buildUrl: (query) => searchUrl("https://www.olx.com.br", "/brasil", "q", query),
  },
  {
    id: "buscape", title: "Buscapé", provider: "Buscapé", category: "marketplaces",
    description: "Modelo de consulta e comparação de resultados de busca.",
    sampleQuery: "notebook", sourceName: "Pesquisa no Buscapé", engine: "HTTP",
    selector: "main article, [data-testid='product-card']", requestIntervalMs: 30000,
    guidance: "Verifique no site se a busca é pública e se os seletores ainda correspondem aos produtos.",
    buildUrl: (query) => searchUrl("https://www.buscape.com.br", "/search", "q", query),
  },
  {
    id: "ebay", title: "eBay", provider: "eBay", category: "marketplaces",
    description: "Acompanhamento inicial de anúncios internacionais.",
    sampleQuery: "camera", sourceName: "Busca no eBay", engine: "HTTP",
    selector: ".s-item", requestIntervalMs: 30000,
    guidance: "Resultados podem variar por região. Respeite limites e regras do site.",
    buildUrl: (query) => searchUrl("https://www.ebay.com", "/sch/i.html", "_nkw", query),
  },
  {
    id: "website", title: "Site genérico", provider: "Seu site", category: "general",
    description: "Modelo de demonstração para qualquer página pública permitida.",
    sampleQuery: "exemplo", sourceName: "Página pública", engine: "HTTP",
    selector: "h1", requestIntervalMs: 10000,
    guidance: "O endereço example.org é demonstrativo; personalize a URL, o seletor e os hosts antes de monitorar seu site.",
    buildUrl: () => "https://example.org/",
  },
];

export function listStarterTemplates() {
  return STARTER_TEMPLATES.map(({ buildUrl, ...item }) => ({
    ...item,
    sampleUrl: buildUrl(item.sampleQuery),
    templateVersion: 1,
    kind: "starter" as const,
  }));
}

export function getStarterTemplate(id: string): StarterTemplate | undefined {
  return STARTER_TEMPLATES.find((item) => item.id === id);
}

export function buildTemplateSource(
  template: StarterTemplate,
  query: string,
  changes: Partial<SourceCreateInput> = {},
): SourceCreateInput {
  const url = changes.url ?? template.buildUrl(query);
  const host = new URL(url).hostname.toLowerCase();
  const candidate = {
    name: changes.name ?? template.sourceName,
    engine: changes.engine ?? template.engine,
    url,
    allowedHosts: changes.allowedHosts ?? [host],
    selector: changes.selector ?? template.selector,
    respectRobots: true, // Template cloning must not disable robots restrictions.
    captureScreenshot: changes.captureScreenshot ?? false,
    requestIntervalMs: changes.requestIntervalMs ?? template.requestIntervalMs,
  };
  return sourceCreateSchema.parse(candidate);
}

export function templateInstanceSlug(name: string, suffix = randomBytes(4).toString("hex")): string {
  const base = searchSlug(name).slice(0, 54);
  return `${base}-${suffix}`;
}
