import { describe, expect, it, vi } from "vitest";
import { ConnectApiError } from "../apps/api/src/connect-api.ts";
import { deleteRemoteInstance } from "../apps/api/src/connect-deletion.ts";

describe("WhatsApp instance remote removal", () => {
  it("deletes using only the scoped instance token", async () => {
    const remove = vi.fn(async () => ({ status: "SUCCESS", error: false }));
    const result = await deleteRemoteInstance("scoped-token", remove);
    expect(result).toBe("removed");
    expect(remove).toHaveBeenCalledWith("scoped-token");
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403])(
    "does not substitute the global administrator for an invalid instance token (HTTP %i)",
    async (status) => {
      const remove = vi.fn(async () => {
        throw new ConnectApiError("Unauthorized", status);
      });
      await expect(
        deleteRemoteInstance("scoped-token", remove),
      ).rejects.toMatchObject({ statusCode: status });
      expect(remove).toHaveBeenCalledTimes(1);
    },
  );

  it.each([404, 410])(
    "is idempotent for remotely missing instances (HTTP %i)",
    async (status) => {
      const remove = vi.fn(async () => {
        throw new ConnectApiError("Not found", status);
      });
      await expect(deleteRemoteInstance("scoped-token", remove)).resolves.toBe(
        "already-missing",
      );
      expect(remove).toHaveBeenCalledTimes(1);
    },
  );

  it("does not treat a timeout or server error as a successful removal", async () => {
    const remove = vi.fn(async () => {
      throw new ConnectApiError("Gateway", 502);
    });
    await expect(
      deleteRemoteInstance("scoped-token", remove),
    ).rejects.toMatchObject({ statusCode: 502 });
  });

  it("rejects failed payloads even with HTTP 200", async () => {
    await expect(
      deleteRemoteInstance("scoped", async () => ({
        error: true,
        status: "ERROR",
      })),
    ).rejects.toThrow(/não confirmou/i);
  });

  it("rejects missing instance tokens without any remote call", async () => {
    const remove = vi.fn();
    await expect(deleteRemoteInstance("", remove)).rejects.toMatchObject({
      statusCode: 401,
    });
    expect(remove).not.toHaveBeenCalled();
  });
});

describe("deleting a workspace instance preserves cross-workspace security", () => {
  it("checks the selected space and its claim before remote deletion", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("apps/api/src/whatsapp-routes.ts", "utf8");
    const section = source.split(
      'app.delete(\n    "/whatsapp/instances/:name"',
    )[1];
    expect(section).toContain(
      "tenantId: tenant, name: parsedName.data, present: true",
    );
    expect(section).toContain("claim.tenantId !== tenant");
    expect(section).toContain(
      "where: { name: instance.name, tenantId: tenant }",
    );
    expect(section).toContain("connectDefaultInstanceName: instance.name");
    expect(section).toContain('z.enum(["remote", "unlink"]).default("remote")');
    expect(section).toContain('mode.data.mode === "remote" && remotelyClaimed');
    expect(section).toContain('action: remotelyClaimed && mode.data.mode === "remote"');
    expect(section).toContain("mode: mode.data.mode");
    expect(section).toContain('? "whatsapp.instance.deleted"');
    expect(section).toContain(': "whatsapp.instance.unlinked"');
  });
});
