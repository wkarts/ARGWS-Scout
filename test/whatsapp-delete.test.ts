import { describe, expect, it, vi } from "vitest";
import { ConnectApiError } from "../apps/api/src/connect-api.ts";
import { deleteRemoteInstance } from "../apps/api/src/connect-deletion.ts";

describe("WhatsApp instance remote removal", () => {
  it("deletes using the scoped token, never requiring the platform key in the normal path", async () => {
    const remove = vi.fn(async () => ({ status: "SUCCESS", error: false }));
    const result = await deleteRemoteInstance("scoped-token", "global-token", remove);
    expect(result).toBe("removed");
    expect(remove).toHaveBeenCalledExactlyOnceWith("scoped-token");
  });

  it("retries with the administrative key only after a scoped token authorization failure", async () => {
    const remove = vi.fn(async (key: string) => {
      if (key === "scoped-token") throw new ConnectApiError("Unauthorized", 401);
      return { status: "SUCCESS" };
    });
    await expect(deleteRemoteInstance("scoped-token", "global-token", remove)).resolves.toBe("removed");
    expect(remove.mock.calls.map((call) => call[0])).toEqual(["scoped-token", "global-token"]);
  });

  it.each([404, 410])("accepts a remotely missing instance (HTTP %i) as already deleted", async (status) => {
    const remove = vi.fn(async () => { throw new ConnectApiError("Not found", status); });
    await expect(deleteRemoteInstance("scoped-token", "global-token", remove)).resolves.toBe("already-missing");
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("never considers a timeout or a remote server failure successful", async () => {
    const remove = vi.fn(async () => { throw new ConnectApiError("Bad gateway", 502); });
    await expect(deleteRemoteInstance("scoped-token", "global-token", remove)).rejects.toMatchObject({ statusCode: 502 });
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("rejects a failed payload even when the remote server returns HTTP 200", async () => {
    await expect(deleteRemoteInstance("scoped", "global", async () => ({ error: true, status: "ERROR" })))
      .rejects.toThrow(/não confirmou/i);
  });

  it("never sends empty credentials to the remote server", async () => {
    const remove = vi.fn();
    await expect(deleteRemoteInstance("", "", remove)).rejects.toMatchObject({ statusCode: 401 });
    expect(remove).not.toHaveBeenCalled();
  });

  it("does not perform duplicate remote calls when scoped and global tokens are equal", async () => {
    const remove = vi.fn(async () => ({ status: "SUCCESS" }));
    await deleteRemoteInstance("same", "same", remove);
    expect(remove).toHaveBeenCalledTimes(1);
  });
});

describe("deleting a workspace instance preserves cross-workspace security", () => {
  it("checks the selected space and its claim before remote deletion", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("apps/api/src/whatsapp-routes.ts", "utf8");
    const section = source.split('app.delete(\n    "/whatsapp/instances/:name"')[1];
    expect(section).toContain("tenantId: tenant, name: parsedName.data, present: true");
    expect(section).toContain("claim.tenantId !== tenant");
    expect(section).toContain("where: { name: instance.name, tenantId: tenant }");
    expect(section).toContain("connectDefaultInstanceName: instance.name");
    expect(section).toContain('action: remotelyClaimed ? "whatsapp.instance.deleted" : "whatsapp.instance.unlinked"');
  });
});
