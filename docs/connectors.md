# Fontes e connectors

Uma fonte pertence a uma instância e usa engine `HTTP` ou `PLAYWRIGHT`. Configure hostname permitido, URL pública, seletor CSS ou caminho JSON, robots.txt, intervalo mínimo e screenshot browser opcional. Templates aceitam `{{input.campo}}`; os valores são codificados antes de validar a URL final.

## Contrato TypeScript

```ts
import { defineConnector } from "@argws/scout-connector-sdk";

export const productSearch = defineConnector({
  id: "catalog.product-search",
  version: "1.0.0",
  displayName: "Busca de produtos",
  engine: "HTTP",
  inputSchema: { query: { type: "string", minLength: 1, maxLength: 120 } },
  async execute({ input, source }) {
    // O runtime fornece o engine seguro; não amplie hosts aqui.
    return {
      requestedUrl: source.url,
      finalUrl: source.url,
      statusCode: 200,
      contentType: "application/json",
      data: { query: input.query },
      capturedAt: new Date().toISOString(),
    };
  },
});
```

O exemplo mostra o contrato; não faz uma requisição sozinho. Conectores com credenciais autenticadas, catálogo assinado, instalação dinâmica de plugins e gestão de cookies ainda não estão disponíveis. Não colete conteúdo protegido ou fora da política do site.
