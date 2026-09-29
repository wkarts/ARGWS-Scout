import { chromium, type Browser } from "playwright";
import type { ConnectorContext, ConnectorResult } from "@argws/scout-core";
import { extractHtml } from "@argws/scout-extraction";
import {
  assertRobotsAllowed,
  assertSafePublicUrl,
} from "@argws/scout-shared/url-policy";

export async function createBrowser(): Promise<Browser> {
  return chromium.launch({
    headless: true,
    chromiumSandbox: true,
    args: ["--disable-dev-shm-usage"],
  });
}

export async function runBrowser(
  context: ConnectorContext,
  browser: Browser,
): Promise<ConnectorResult> {
  const { source } = context;
  if (source.respectRobots)
    await assertRobotsAllowed(source.url, source.allowedHosts);
  const timeout = Number(process.env.SCOUT_BROWSER_TIMEOUT_MS ?? 30000);
  const page = await browser.newPage({
    javaScriptEnabled: true,
    acceptDownloads: false,
  });
  await page.route("**/*", async (route) => {
    try {
      const requestUrl = route.request().url();
      if (
        ["data:", "blob:", "about:"].some((scheme) =>
          requestUrl.startsWith(scheme),
        )
      )
        return route.continue();
      await assertSafePublicUrl(
        requestUrl,
        source.allowedHosts,
        process.env.SCOUT_ALLOW_HTTP === "true",
      );
      return route.continue();
    } catch {
      return route.abort("blockedbyclient");
    }
  });
  try {
    const navigation = await page.goto(source.url, {
      waitUntil: "domcontentloaded",
      timeout,
    });
    await page
      .waitForLoadState("networkidle", { timeout: Math.min(timeout, 10000) })
      .catch(() => undefined);
    const finalUrl = page.url();
    await assertSafePublicUrl(
      finalUrl,
      source.allowedHosts,
      process.env.SCOUT_ALLOW_HTTP === "true",
    );
    const html = await page.content();
    const responseStatus = navigation?.status() ?? 0;
    const data: Record<string, unknown> = extractHtml(html, source.selector);
    if (source.captureScreenshot) {
      const screenshot = await page.screenshot({
        type: "png",
        fullPage: false,
        animations: "disabled",
      });
      if (screenshot.byteLength <= 500_000)
        data.screenshotBase64 = screenshot.toString("base64");
      else
        data.screenshotOmitted = "captura maior que o limite inline de 500 KB";
    }
    return {
      requestedUrl: source.url,
      finalUrl,
      statusCode: Number.isFinite(responseStatus) ? responseStatus : 0,
      contentType: "text/html",
      data,
      capturedAt: new Date().toISOString(),
    };
  } finally {
    await page.close();
  }
}
