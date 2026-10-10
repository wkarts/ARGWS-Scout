import { describe, expect, it } from "vitest";
import { chromiumSandboxEnabled } from "../packages/engine-playwright/src/index.ts";

describe("Chromium sandbox policy", () => {
  it("keeps sandbox enabled by default outside Docker deployment bundles", () => {
    expect(chromiumSandboxEnabled({})).toBe(true);
    expect(chromiumSandboxEnabled({ SCOUT_BROWSER_CHROMIUM_SANDBOX: "true" })).toBe(
      true,
    );
  });

  it("allows an explicit isolated-container opt-out", () => {
    expect(chromiumSandboxEnabled({ SCOUT_BROWSER_CHROMIUM_SANDBOX: "false" })).toBe(
      false,
    );
  });

  it("fails closed for invalid configuration", () => {
    expect(() =>
      chromiumSandboxEnabled({ SCOUT_BROWSER_CHROMIUM_SANDBOX: "off" }),
    ).toThrow(/true ou false/);
  });
});
