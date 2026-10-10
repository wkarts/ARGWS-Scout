import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("Manager responsive layout contract", () => {
  it("renders the footer inside the main column, not as another horizontal flex child", () => {
    const app = source("apps/manager/src/App.vue");
    const root = app.indexOf('<div v-else class="app-shell">');
    const column = app.indexOf('<section class="main-column">', root);
    const mainClose = app.indexOf("</main>", column);
    const footer = app.indexOf('<footer class="app-footer">', column);
    const columnClose = app.indexOf("</section>", mainClose);
    expect(root).toBeGreaterThan(-1);
    expect(column).toBeGreaterThan(root);
    expect(footer).toBeGreaterThan(mainClose);
    expect(footer).toBeLessThan(columnClose);
    expect(app.indexOf('<footer class="app-footer">', columnClose)).toBe(-1);
  });

  it("supports 320px mobile and fluid content width without fixed third column", () => {
    const css = source("apps/manager/src/style.css");
    expect(css).toContain(".main-column { flex: 1 1 0%;");
    expect(css).toContain(".main-column { width: 100%; max-width: 100%;");
    expect(css).toContain(".main-column > .app-footer");
    expect(css).toContain(".guide-steps article > div");
    expect(css).toContain("minmax(0, 1fr)");
  });
});

describe("workspace Connect|API UI", () => {
  it("never requests global Connect|API credentials from a signed-in user", () => {
    const vue = source("apps/manager/src/views/WhatsAppConsole.vue");
    expect(vue).not.toContain('v-model="apiKey"');
    expect(vue).not.toContain('v-model="baseUrl"');
    expect(vue).not.toContain('method: "PUT",\n      body: JSON.stringify({ baseUrl');
    expect(vue).toContain("Revalidar vínculo");
    expect(vue).toContain("token particular");
  });
  it("never enumerates all global remote instances for per-workspace synchronization", () => {
    const api = source("apps/api/src/whatsapp-routes.ts");
    expect(api).not.toContain('path: "instance/fetchInstances"');
    expect(api).not.toContain("prisma.connectApiConfig.findUnique");
    expect(api).toContain("connectInstanceClaim");
    expect(api).toContain("loadRemoteInstance");
    expect(api).toContain('"/whatsapp/instances/claim"');
  });
});
