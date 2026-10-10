import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const file = (name: string) => readFileSync(resolve(process.cwd(), name), "utf8");

describe("Modelos prontos no Manager", () => {
  it("exibe acesso ao catálogo e a opção de clonar a partir da instância", () => {
    const app = file("apps/manager/src/App.vue");
    expect(app).toContain('import TemplateCatalog from "./views/TemplateCatalog.vue"');
    expect(app).toContain("Modelos prontos");
    expect(app).toContain('activeSection === \'templates\'');
    expect(app).toContain("@created=\"onTemplateCreated\"");
    expect(app).toContain("Escolher modelo pronto");
  });
  it("oferece personalização e utiliza URL do modelo por padrão", () => {
    const view = file("apps/manager/src/views/TemplateCatalog.vue");
    expect(view).toContain("Criar minha instância");
    expect(view).toContain('"/instance-templates/"');
    expect(view).toContain("urlOverride.value.trim()");
    expect(view).toContain("requestIntervalMs");
    expect(view).toContain("PLAYWRIGHT");
  });
  it("mantém edição de fontes e aplica os mesmos controles de URL do cadastro", () => {
    const routes = file("apps/api/src/routes.ts");
    expect(routes).toContain('registerTemplateRoutes(app)');
    expect(routes).toContain('"/sources/:sourceId"');
    expect(routes).toContain("sourceCreateSchema.safeParse");
    expect(routes).toContain("assertSafePublicUrl");
    const manager = file("apps/manager/src/App.vue");
    expect(manager).toContain("function openSourceForm(source?: Source)");
    expect(manager).toContain('method: updatedExisting ? "PATCH" : "POST"');
  });
});
