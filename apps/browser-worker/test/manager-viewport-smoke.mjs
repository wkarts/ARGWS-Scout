import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";

const base = process.env.SCOUT_PREVIEW_URL ?? "http://127.0.0.1:4173";
const id = "11111111-1111-4111-8111-111111111111";
const me = {
  user: {
    id,
    email: "view@example.test",
    name: "Conta Visual",
    profile: {},
    mfaEnabled: true,
  },
  role: "OWNER",
  mfaRequiredForOwner: true,
  tenant: { id, name: "Espaço Visual", slug: "espaco-visual" },
};
function mock(path) {
  if (path === "/auth/me") return me;
  if (path === "/profile/spaces")
    return {
      data: [{ id, name: "Espaço Visual", role: "OWNER", current: true }],
    };
  if (path === "/overview")
    return {
      stats: { instances: 0, sources: 0, jobsRecent: 0, completed: 0 },
      recentJobs: [],
    };
  if (path === "/instance-templates")
    return {
      version: 1,
      data: [
        {
          id: "amazon", title: "Amazon Brasil", provider: "Amazon",
          category: "marketplaces", description: "Resultados de busca pública",
          sampleQuery: "monitor", sampleUrl: "https://www.amazon.com.br/s?k=monitor",
          sourceName: "Busca na Amazon", selector: "[data-component-type='s-search-result']",
          engine: "HTTP", requestIntervalMs: 30000,
          guidance: "Confira as regras da página antes de executar.",
          templateVersion: 1,
        },
        {
          id: "mercado-livre", title: "Mercado Livre", provider: "Mercado Livre",
          category: "marketplaces", description: "Anúncios públicos",
          sampleQuery: "notebook", sampleUrl: "https://lista.mercadolivre.com.br/notebook",
          sourceName: "Resultados do Mercado Livre", selector: ".ui-search-layout",
          engine: "HTTP", requestIntervalMs: 15000,
          guidance: "Reveja seletores e políticas de acesso.",
          templateVersion: 1,
        },
      ],
    };
  if (path === "/whatsapp")
    return {
      configured: true,
      mode: "global",
      defaultInstanceName: null,
      instances: [],
      canManage: true,
      canPublish: true,
    };
  if (path === "/integrations/smtp")
    return { configured: false, recoveryConfigured: false, config: null };
  return { data: [] };
}
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}),
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const widths = [320, 360, 390, 500, 768, 1024, 1440, 1920];
const dir = process.env.SCOUT_SCREENSHOT_DIR ?? "/tmp/scout-responsive";
await mkdir(dir, { recursive: true });
try {
  for (const width of widths) {
    const context = await browser.newContext({
      viewport: { width, height: 850 },
      deviceScaleFactor: 1,
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/api/v1/**", async (route) => {
      const pathname = new URL(route.request().url()).pathname.replace(
        /^\/api\/v1/,
        "",
      );
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(mock(pathname)),
      });
    });
    await page.goto(base, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.locator(".main-column").waitFor({ timeout: 15000 });
    if (width <= 760)
      await page.getByRole("button", { name: "Abrir menu" }).click();
    await page
      .getByRole("button", { name: "Primeiros passos", exact: true })
      .click();
    // selectSection closes the mobile drawer itself; do not click a now-hidden close control.
    await page
      .getByText("Da primeira busca à publicação")
      .waitFor({ timeout: 15000 });
    await page.screenshot({
      path: dir + "/scout-" + width + ".png",
      fullPage: true,
    });
    const g = await page.evaluate(() => {
      const main = document
        .querySelector(".main-column")
        ?.getBoundingClientRect();
      const footer = document
        .querySelector(".app-footer")
        ?.getBoundingClientRect();
      const guide = document
        .querySelector(".guide-panel")
        ?.getBoundingClientRect();
      const cards = [...document.querySelectorAll(".guide-steps article")].map(
        (n) => n.getBoundingClientRect(),
      );
      return {
        pageWidth: document.documentElement.scrollWidth,
        mainRight: main?.right,
        mainLeft: main?.left,
        footerRight: footer?.right,
        footerLeft: footer?.left,
        guideRight: guide?.right,
        cardRights: cards.map((card) => card.right),
        cardWidths: cards.map((card) => card.width),
      };
    });
    const problems = [];
    if (g.pageWidth > width + 2)
      problems.push("Horizontal scroll " + g.pageWidth + " > " + width);
    if (Math.abs((g.mainRight ?? 0) - width) > 3)
      problems.push("Main does not fill viewport");
    if ((g.footerRight ?? width + 1) > (g.mainRight ?? 0) + 2)
      problems.push("Footer outside main width");
    if ((g.footerLeft ?? -1) < (g.mainLeft ?? 0) - 2)
      problems.push("Footer outside main left");
    if ((g.guideRight ?? width + 1) > width + 2)
      problems.push("Guide panel overflows");
    if (g.cardRights.some((x) => x > width + 2))
      problems.push("Guide card overflows");
    if (g.cardWidths.some((x) => x < 100))
      problems.push("Compressed guide card");
    if (errors.length) problems.push("Browser errors: " + errors.join("; "));
    console.log(JSON.stringify({ width, geometry: g, problems }));
    // Validate the new marketplace template gallery, including its customization panel.
    if (width <= 760)
      await page.getByRole("button", { name: "Abrir menu" }).click();
    await page.getByRole("button", { name: "Modelos prontos", exact: true }).click();
    await page.locator(".template-grid").waitFor({ timeout: 15000 });
    await page.getByRole("button", { name: /Amazon Brasil/ }).click();
    await page.getByText("Criar minha instância").waitFor({ timeout: 15000 });
    const tg = await page.evaluate(() => ({
      pageWidth: document.documentElement.scrollWidth,
      galleryRight: document.querySelector(".template-catalog")?.getBoundingClientRect().right,
      cards: [...document.querySelectorAll(".template-card")].map((element) => element.getBoundingClientRect().right),
      editorRight: document.querySelector(".template-editor")?.getBoundingClientRect().right,
      inputs: [...document.querySelectorAll(".template-editor input")].map((element) => element.getBoundingClientRect().right),
    }));
    if (tg.pageWidth > width + 2) problems.push("Template catalog horizontal scroll");
    if ((tg.galleryRight ?? width+1) > width+2) problems.push("Template catalog overflow");
    if (tg.cards.some((right) => right > width+2)) problems.push("Template card overflow");
    if ((tg.editorRight ?? width+1) > width+2) problems.push("Template editor overflow");
    if (tg.inputs.some((right) => right > width+2)) problems.push("Template field overflow");
    await page.screenshot({ path: dir + "/templates-" + width + ".png", fullPage: true });
    if (errors.length) problems.push("Browser errors in template gallery: " + errors.join("; "));
    console.log(JSON.stringify({ width, templates: tg, problems }));
    await context.close();
    if (problems.length)
      throw new Error("Viewport " + width + "px: " + problems.join("; "));
  }
} finally {
  await browser.close();
}
