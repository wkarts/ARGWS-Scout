import { describe, expect, it } from "vitest";
import { renderInputTemplate } from "../packages/core/src/index.ts";
import { sourceCreateSchema } from "../packages/schemas/src/index.ts";
import { assertSafePublicUrl } from "../packages/shared/src/url-policy.ts";

describe("URL templates", () => {
  it("encodes untrusted query input before rendering a source URL", () => {
    expect(
      renderInputTemplate("https://catalog.example/search?q={{input.query}}", {
        query: "SSD 2TB&sort=price",
      }),
    ).toBe("https://catalog.example/search?q=SSD%202TB%26sort%3Dprice");
  });

  it("rejects missing and object template values", () => {
    expect(() =>
      renderInputTemplate("https://catalog.example/{{input.path}}", {}),
    ).toThrow();
    expect(() =>
      renderInputTemplate("https://catalog.example/{{input.path}}", {
        path: { admin: true },
      }),
    ).toThrow();
  });
});

describe("source contracts", () => {
  it("requires exact URL hostname in the source allowlist", () => {
    const result = sourceCreateSchema.safeParse({
      name: "Busca",
      engine: "HTTP",
      url: "https://catalog.example/search",
      allowedHosts: ["other.example"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects credentials embedded in URLs", () => {
    const result = sourceCreateSchema.safeParse({
      name: "Busca",
      engine: "HTTP",
      url: "https://user:pass@catalog.example/search",
      allowedHosts: ["catalog.example"],
    });
    expect(result.success).toBe(false);
  });
});

describe("SSRF policy", () => {
  it("blocks loopback even if development HTTP is enabled", async () => {
    await expect(
      assertSafePublicUrl("http://127.0.0.1:8080/", ["127.0.0.1"], true),
    ).rejects.toThrow(/privado|reservado/i);
  });

  it("requires HTTPS unless the development override is explicitly enabled", async () => {
    await expect(
      assertSafePublicUrl("http://192.0.2.1/", ["192.0.2.1"], false),
    ).rejects.toThrow(/HTTPS/);
  });
});
