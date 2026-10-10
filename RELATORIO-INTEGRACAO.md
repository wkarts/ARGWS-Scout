# Relatório de integração — Scout 0.7.0

**Situação:** implementação candidata entregue em ZIP, sem alteração de versão; nenhum merge/deploy ou publicação GHCR executados.

## Escopo

Integração aditiva do Motor de Publicações 2.0.0 à arquitetura Scout: normalizador Python genérico (KaBuM!, HTTP/API, Playwright, HTML, JSON, schema.org), identidade e histórico por instância/organização, armazenamento existente Garage/S3, RabbitMQ/outbox, geração de artes e textos para vários canais, aprovação e interface Vue.

## Verificações executadas localmente

- **13/13** testes Python passaram (`pytest`), incluindo o serviço FastAPI interno, sanitização de captura e imagens.
- **8/8** distribuições Compose independentes passaram `test/deployment-contract.py`; Compose raiz e modelo operacional também incluem o perfil opcional.
- **10/10** imagens-base GHCR passaram a validação estática de pins.
- **10/10** Compose tiveram estrutura YAML validada; ambos os serviços opcionais constam dos arquivos e o Python não publica porta no host.
- **53** caminhos no contrato OpenAPI, **11** de refinamento/publicações.
- **8** arquivos TypeScript/scripts Vue verificados em sintaxe por transpilation; checagem completa de tipos ainda pendente.
- Dois exemplos reais fornecidos: **60 + 60 itens**, **6 identificadores de produto encontrados em ambas as capturas**. A busca RTX 5050 assinalou **18** itens para revisão e a categoria ampla **38** (critérios do novo normalizador). Amostra offline gera imagens ilustrativas pois as capturas não incluíam links de fotos.
- O diagnóstico JSON original inclui **2 coletas Mercado Livre com COLLECTION_FAILED**, 3 tentativas cada; não inclui erro detalhado, portanto a correção dessa causa não foi comprovada.

## Limitações que impedem declaração de paridade de produção

- Não houve execução de Docker, validação `docker compose config`, deploy, build GHCR ou pull das imagens.
- Não houve acesso a dependências npm/pnpm nem banco PostgreSQL para `prisma validate/migrate`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm format:check` e end-to-end browser/DB/filas; CI deve confirmar antes de merge.
- Scraping genérico é heurístico e não garante precisão de 100% em todos os sites; campos de imagem dependem dos dados publicados nas páginas.
- Sem envio automático de WhatsApp, SMTP ou outros canais. Exportações são rascunhos sujeitos a revisão e autorização por canal.
- Serviços são **opt-in**, desativados por padrão. Necessitam migração DB e publicação prévia das duas imagens GHCR para uma stack remota.

## Contrato de preservação

Os arquivos originais foram comparados por SHA-256 com o ZIP da versão 0.7.0. Nenhum arquivo do original foi removido; os existentes alterados foram mantidos na aplicação integrada (sem substituição deliberada de motores, autenticação, domínios ou volumes). Validação de regressão completa depende da CI.

## Arquivos comparados com a versão original

- Base: **203** arquivos originais.
- Entrega: **237** arquivos.
- Novos: **34**.
- Alterados: **39**.
- Removidos: **0**.

### Arquivos modificados

- `.env.example`
- `.github/ghcr-bases.json`
- `.github/workflows/ci.yml`
- `.github/workflows/ghcr-publish-application.yml`
- `README.md`
- `apps/api/src/routes.ts`
- `apps/dispatcher/src/dispatcher.ts`
- `apps/docs/index.html`
- `apps/docs/viewer.js`
- `apps/manager/src/App.vue`
- `apps/worker/src/execute-job.ts`
- `compose.yaml`
- `deploy/cloudpanel/develop/.env.example`
- `deploy/cloudpanel/develop/compose.yaml`
- `deploy/cloudpanel/production/.env.example`
- `deploy/cloudpanel/production/compose.yaml`
- `deploy/docker/develop/.env.example`
- `deploy/docker/develop/compose.yaml`
- `deploy/docker/production/.env.example`
- `deploy/docker/production/compose.yaml`
- `deploy/dockge/develop/.env.example`
- `deploy/dockge/develop/compose.yaml`
- `deploy/dockge/production/.env.example`
- `deploy/dockge/production/compose.yaml`
- `deploy/portainer/develop/.env.example`
- `deploy/portainer/develop/compose.yaml`
- `deploy/portainer/production/.env.example`
- `deploy/portainer/production/compose.yaml`
- `docs/deployment.md`
- `docs/openapi.yaml`
- `ops/deployment/compose.yaml`
- `ops/deployment/env.example`
- `packages/core/src/index.ts`
- `packages/extraction/src/index.ts`
- `pnpm-lock.yaml`
- `prisma/schema.prisma`
- `scripts/ghcr-bases.py`
- `scripts/validate-compose-model.py`
- `test/deployment-contract.py`

### Arquivos novos

- `CHANGELOG-INTEGRACAO-CONTEUDO.md`
- `Dockerfile.content-engine`
- `RELATORIO-INTEGRACAO.md`
- `apps/api/src/content-routes.ts`
- `apps/content-engine/README.md`
- `apps/content-engine/api.py`
- `apps/content-engine/examples/exemplo_com_multiplas_imagens.json`
- `apps/content-engine/examples/exemplo_generico.json`
- `apps/content-engine/examples/kabum_entrada_reconstituida.json`
- `apps/content-engine/examples/midias/exemplo-1.png`
- `apps/content-engine/examples/midias/exemplo-2.png`
- `apps/content-engine/examples/requisicao_api.json`
- `apps/content-engine/motor_publicacoes/__init__.py`
- `apps/content-engine/motor_publicacoes/__main__.py`
- `apps/content-engine/motor_publicacoes/adapter_kabum.py`
- `apps/content-engine/motor_publicacoes/api.py`
- `apps/content-engine/motor_publicacoes/cli.py`
- `apps/content-engine/motor_publicacoes/delivery.py`
- `apps/content-engine/motor_publicacoes/engine.py`
- `apps/content-engine/motor_publicacoes/ingestion.py`
- `apps/content-engine/motor_publicacoes/media.py`
- `apps/content-engine/motor_publicacoes/publications.py`
- `apps/content-engine/motor_publicacoes/xlsx_export.py`
- `apps/content-engine/requirements.txt`
- `apps/content-engine/tests/test_motor.py`
- `apps/content-engine/tests/test_scout_integration.py`
- `apps/content-worker/package.json`
- `apps/content-worker/src/worker.ts`
- `apps/content-worker/tsconfig.json`
- `apps/manager/src/views/ContentConsole.vue`
- `docs/content-refinement.md`
- `packages/core/src/content-settings.ts`
- `prisma/migrations/20261010220000_content_refinement_and_publications/migration.sql`
- `test/content-refinement.test.ts`

## Ativação e configuração

Consulte `docs/content-refinement.md`. Use `SCOUT_CONTENT_ENABLED=true`, `COMPOSE_PROFILES=content`, chave `SCOUT_CONTENT_ENGINE_KEY` aleatória de 32+ caracteres, migração existente e verificação das imagens GHCR, preservando `COMPOSE_PROJECT_NAME`, volumes e credenciais antigas.
