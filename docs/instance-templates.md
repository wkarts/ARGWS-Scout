# Modelos prontos — catálogo de instâncias

O Scout disponibiliza **dez modelos iniciais editáveis** para iniciar monitoramentos sem montar uma fonte do zero. O catálogo é acessado em **Modelos prontos**, ou em **Instâncias → Escolher modelo**. Cada modelo cria uma **instância privada no espaço de trabalho ativo**, com sua própria fonte, URL, allowlist de hosts e configurações de coleta.

## Modelos disponíveis

| Modelo | Uso inicial | Mecanismo padrão |
| --- | --- | --- |
| Mercado Livre | Busca pública de anúncios/produtos | HTTP |
| Shopee | Pesquisa pública de produtos | Navegador |
| Amazon Brasil | Resultados de busca pública | HTTP |
| Magazine Luiza | Busca de ofertas | HTTP |
| AliExpress | Pesquisa de produtos | HTTP |
| KaBuM! | Informática e eletrônicos | HTTP |
| OLX Brasil | Classificados públicos | HTTP |
| Buscapé | Comparação e busca de produtos | HTTP |
| eBay | Anúncios internacionais | HTTP |
| Site genérico | Demonstração e adaptação a qualquer site autorizado | HTTP |

Os modelos são **presets comunitários de páginas públicas**, e **não integrações oficiais** ou credenciais autorizadas dos marketplaces. Não garantimos que a página responderá: alguns sites usam JavaScript, redirecionamentos, verificações de acesso e mudanças frequentes de layout.

Para operações comerciais autenticadas, catálogos privados, pedidos e preços de vendedor, prefira as APIs oficiais com autorização específica. Ex.: [Mercado Livre — Busca de itens](https://developers.mercadolivre.com.br/pt_br/itens-e-buscas) e [Amazon Selling Partner API](https://developer-docs.amazon.com/sp-api/docs/connecting-to-the-selling-partner-api). O Scout **ainda não implementa autenticação OAuth dessas APIs nesse catálogo**.

## Criar uma instância a partir de modelo

1. Entre no Manager e abra **Modelos prontos**.
2. Pesquise por loja, ou filtre **Marketplaces** e **Sites gerais**.
3. Clique no modelo desejado. O Scout preenche nome, termo de busca, fonte, mecanismo, seletor CSS e intervalo sugerido.
4. Personalize qualquer campo necessário: termo, fonte, seletor, mecanismo, captura e intervalo. Se preferir outra página permitida, substitua a URL no campo avançado.
5. Clique em **Criar minha instância**. O Scout cria a instância e uma fonte **atomicamente**, dentro do espaço selecionado. Nenhuma execução é iniciada automaticamente.
6. A instância abre em **Fontes configuradas**. Use **Editar fonte** para melhorar URL, seletor, mecanismo e intervalo quantas vezes precisar.
7. Faça uma coleta manual em **Executar**. Confira texto, títulos, links, JSON, screenshot opcional e código HTTP antes de agendar coletas ou publicar resultados.

## Segurança e limites de uso

- O preset usa HTTPS, hosts permitidos por origem, `respectRobots=true` e intervalos conservadores (10–30 segundos).
- O backend valida a URL real com a mesma política anti-SSRF usada pelo cadastro manual, verificando hosts públicos e bloqueando acessos indevidos.
- A instância e seus resultados têm `tenantId` derivado da sessão autenticada, nunca do JSON enviado pelo navegador.
- Nenhum marketplace é acessado automaticamente ao escolher o modelo ou finalizar o cadastro. O usuário precisa solicitar uma execução ou agendamento.
- Se a fonte for bloqueada por robots.txt, HTTP 403, CAPTCHA, autenticação ou outra restrição, ajuste o monitoramento ou utilize uma API oficial aprovada. **Não contorne proteções**.
- Os seletores CSS são apenas exemplos e podem deixar de funcionar. Corrija-os na fonte clonada sem modificar o catálogo global.
- Clones são independentes: alterar uma instância não muda as fontes dos demais usuários nem o modelo original.

## Endpoints disponíveis

| Endpoint | Ação |
| --- | --- |
| `GET /api/v1/instance-templates` | Lista modelos e exemplos, requer sessão do Manager |
| `POST /api/v1/instance-templates/{templateId}/create` | Cria instância e primeira fonte num único cadastro, para OWNER/ADMIN/OPERATOR |
| `PATCH /api/v1/sources/{sourceId}` | Personaliza a fonte existente mediante autorização no espaço e validação anti-SSRF |

Exemplo de criação pelo Manager (o token de sessão é enviado por cookie HTTP-only e a aplicação adiciona proteção CSRF conforme sua configuração):

```json
{
  "name": "Pesquisa de notebooks",
  "query": "notebook gamer",
  "source": {
    "engine": "HTTP",
    "selector": "[data-component-type='s-search-result']",
    "requestIntervalMs": 30000
  }
}
```

É possível adaptar uma URL e o motor da fonte, mas a criação via catálogo não desativa `respectRobots`. Não envie cookies de marketplaces, chaves OAuth, senhas ou tokens pelos campos de modelo.

## Como evoluir o catálogo

Os dez modelos são declarados no código do backend, em `apps/api/src/instance-templates.ts`, com identificadores imutáveis, versões e construtores de URL. Novos templates devem ser adicionados com testes do contrato de URL, allowlist, limites e isolamento. Os usuários personalizam **cópias**, nunca a configuração original global. Uma futura biblioteca privada de modelos por espaço de trabalho exigirá versionamento, RBAC e fluxo de publicação próprios.
