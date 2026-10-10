import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("documentation pages must render under the restrictive Nginx CSP", () => {
  const pages = [
    ["index.html", "index.css"],
    ["first-steps.html", "first-steps.css"],
    ["user-guide.html", "user-guide.css"],
  ];
  const dockerfile = source("Dockerfile.docs");
  const policy = source("apps/docs/nginx.conf");

  it.each(pages)("%s has its own external stylesheet actually included in the image", (html, css) => {
    const page = source("apps/docs/" + html);
    const sheet = source("apps/docs/" + css);
    expect(page).toContain('href="/docs/' + css + '"');
    expect(page).not.toContain("<style>");
    expect(page).not.toContain('style="');
    expect(sheet).toMatch(/min-width|@media/);
    expect(dockerfile).toContain("COPY apps/docs/" + css + " /usr/share/nginx/html/" + css);
  });

  it("keeps a strict CSP and does not enable unsafe-inline", () => {
    expect(policy).toContain("style-src 'self'");
    expect(policy).not.toContain("style-src 'self' 'unsafe-inline'");
  });

  it("opens OpenAPI and Markdown in a navigable viewer, not as forced downloads", () => {
    const index = source("apps/docs/index.html");
    const viewer = source("apps/docs/viewer.js");
    expect(index).toContain("/docs/viewer.html?doc=openapi");
    expect(index).toContain("/docs/viewer.html?doc=architecture");
    expect(viewer).toContain('const isApi = key === "openapi"');
    expect(viewer).toContain("renderMarkdown(source)");
    const nginx = source("apps/docs/nginx.conf");
    expect(nginx).toContain('Content-Disposition "inline"');
  });
});
