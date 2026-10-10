import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import {
  renderMarkdown,
  readOpenApiOperations,
} from "../apps/docs/viewer-core.mjs";

function source(path) {
  return readFileSync(new URL("../" + path, import.meta.url), "utf8");
}

describe("self-hosted online documentation", () => {
  it("renders common Markdown structure and escapes untrusted HTML", () => {
    const document = [
      "# Manual",
      "",
      "**Importante** e `parâmetro`",
      "",
      "| Campo | Valor |",
      "| --- | --- |",
      "| Nome | Scout |",
      "",
      "```bash",
      "echo teste",
      "```",
      "",
      "[Arquitetura](./architecture.md)",
      "",
      "<img src=x onerror=alert(1)>",
    ].join("\n");
    const rendered = renderMarkdown(document);
    expect(rendered).toContain("<h1");
    expect(rendered).toContain("<strong>Importante</strong>");
    expect(rendered).toContain("<code>parâmetro</code>");
    expect(rendered).toContain("<table>");
    expect(rendered).toContain("<pre>");
    expect(rendered).toContain("/docs/viewer.html?doc=architecture");
    expect(rendered).not.toContain("<img src=x");
    expect(rendered).toContain("&lt;img");
  });

  it("rejects unsafe inline Markdown URLs", () => {
    const rendered = renderMarkdown("[ir](javascript:alert)");
    expect(rendered).not.toContain('href="javascript:');
    expect(rendered).toContain('href="#"');
  });

  it("displays the real OpenAPI contract as searchable endpoint cards", () => {
    const operations = readOpenApiOperations(source("docs/openapi.yaml"));
    expect(operations.length).toBeGreaterThan(10);
    expect(operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: "POST", path: "/auth/login" }),
      ]),
    );
    expect(
      operations.some((item) => item.contract.includes("responses:")),
    ).toBe(true);
  });

  it("links to HTML viewers rather than raw Markdown or OpenAPI downloads", () => {
    const landing = source("apps/docs/index.html");
    expect(landing).toContain("/docs/viewer.html?doc=openapi");
    expect(landing).toContain("/docs/viewer.html?doc=architecture");
    expect(landing).not.toMatch(/href="[^"]+\.(?:md|yaml)"/);
    const viewer = source("apps/docs/viewer.html");
    expect(viewer).toContain("/docs/viewer.js");
    expect(source("apps/docs/viewer.js")).toContain("fetch(url");
    const files = readdirSync(new URL("../apps/docs/", import.meta.url));
    for (const required of [
      "viewer.css",
      "viewer.js",
      "viewer-core.mjs",
      "viewer.html",
      "nginx.conf",
    ]) {
      expect(files).toContain(required);
    }
    const docker = source("Dockerfile.docs");
    expect(docker).toContain("COPY apps/docs/viewer.html");
    expect(docker).toContain("COPY apps/docs/viewer-core.mjs");
    expect(source("apps/docs/nginx.conf")).toContain(
      'Content-Disposition "inline"',
    );
  });
});
