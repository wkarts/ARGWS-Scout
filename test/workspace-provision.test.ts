import { describe, expect, it, vi } from "vitest";
import { Prisma, TenantRole } from "@prisma/client";
import { provisionIndependentSpace } from "../apps/api/src/invitations.ts";

describe("provisionamento lógico de espaços pessoais", () => {
  it("cria uma organização, concede acesso de proprietário e prepara a primeira instância", async () => {
    const createSpace = vi.fn(async () => ({ id: "space-123" }));
    const createMembership = vi.fn(async () => ({ userId: "user-123" }));
    const createInstance = vi.fn(async () => ({ id: "instance-123" }));
    const tx = {
      tenant: { create: createSpace },
      membership: { create: createMembership },
      instance: { create: createInstance },
    } as unknown as Prisma.TransactionClient;

    expect(await provisionIndependentSpace(tx, "user-123", "Estúdio Beatriz")).toBe(
      "space-123",
    );
    expect(createSpace).toHaveBeenCalledWith({
      data: expect.objectContaining({
        name: "Estúdio Beatriz",
        slug: expect.stringMatching(/^estudio-beatriz-[0-9a-f]{16}$/),
      }),
    });
    expect(createMembership).toHaveBeenCalledWith({
      data: {
        tenantId: "space-123",
        userId: "user-123",
        role: TenantRole.OWNER,
      },
    });
    expect(createInstance).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: "space-123",
        slug: "primeira-instancia",
      }),
    });
  });

  it("não reutiliza o slug de uma segunda organização", async () => {
    const slugs: string[] = [];
    const createSpace = vi.fn(async (input: { data: { slug: string } }) => {
      slugs.push(input.data.slug);
      return { id: input.data.slug };
    });
    const tx = {
      tenant: { create: createSpace },
      membership: { create: vi.fn(async () => ({})) },
      instance: { create: vi.fn(async () => ({})) },
    } as unknown as Prisma.TransactionClient;

    await provisionIndependentSpace(tx, "user-a", "Meu espaço");
    await provisionIndependentSpace(tx, "user-b", "Meu espaço");
    expect(slugs[0]).not.toEqual(slugs[1]);
    expect(slugs).toHaveLength(2);
  });
});
