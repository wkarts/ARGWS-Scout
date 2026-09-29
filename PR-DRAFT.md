# Pull Request

## Branch

`feat/scout-operational-platform-alpha-2`

## Título

`feat(scout): amplia operação, Manager e deployment GHCR`

## Descrição

### Contexto

A primeira alpha da ARGWS Scout ficou abaixo do padrão operacional que o time já pratica no ARGWS Connect|API. Esta mudança amplia o Manager, os processos de coleta e a operação de instalação para que a Scout seja revisável e implantável como um sistema completo.

### Objetivo

Entregar uma baseline alpha com governança operacional no Manager, armazenamento S3 compatível, fluxo local completo, bundles reproduzíveis para Docker/Dockge/CloudPanel/Portainer e publicação de imagens pelo GHCR.

### Escopo

**Incluído:**

- Manager com visão de sucesso e volume, busca/filtros de execução, controles operacionais, gestão de acesso, auditoria e saúde de dependências.
- API de diagnóstico para PostgreSQL, Redis, RabbitMQ e bucket S3, com fila, falhas recentes e runtime.
- Serviço de armazenamento S3 com Garage, credenciais por instalação, bootstrap idempotente, backup/restauração e ferramenta de migração de objetos da alpha MinIO.
- Fluxo de desenvolvimento que inicializa API, Manager, dispatcher, workers HTTP/browser, scheduler e worker de webhooks em watch.
- Oito bundles independentes de deploy, imagem multiarch de bootstrap Garage, GHCR de aplicações e espelho versionado de imagens de infraestrutura.
- Quality gates de banco, tipagem, testes, build, formato, SemVer e contratos dos bundles.

**Fora do escopo:**

- Execução de deploy, publicação de imagens, release ou PR remota; esta pasta não possui repositório Git nem remote configurado.
- Alta disponibilidade Garage multi-nó, métricas Prometheus, SSO federado, cofre externo e teste de carga em produção.

### Decisões técnicas e arquitetura

- Mantém a Scout como produto independente; Connect|API foi referência de operação, não dependência de runtime ou código.
- O Manager é a única porta publicada nos bundles de instalação e vincula em loopback para CloudPanel fazer TLS e proxy reverso. Banco, cache, fila e Garage ficam somente na rede privada.
- Garage fornece endpoint S3 compatível. A instância `single-node` é self-hosted e não replica dados fora do host; backup externo e teste de restore continuam necessários.
- Um Dockerfile auxiliar combina o binário Garage com Alpine porque a imagem upstream Garage é `scratch` e não inclui shell.
- As imagens de aplicação são imutáveis por versão no canal estável, com aliases `develop` e `stable`; não há uso de `latest`.

### Alterações realizadas

- Acrescenta contagem e taxa de sucesso em 24 horas à visão geral; adiciona controles para jobs enfileirados, fontes, schedules, tokens, usuários, MFA, webhooks e auditoria.
- Faz `/v1/ops/health` consultar o bucket via API S3 e exibir dependências e atividade operacional no Manager.
- Generaliza o cliente S3 e adiciona `pnpm storage:migrate`: lista, transfere em fluxo, preserva metadados e valida tamanho/SHA-256 sem apagar o bucket de origem.
- Adiciona geração de segredos com permissões `0600`, configuração local, pré-validação, atualização, status, backup e restauração.
- Atualiza Playwright para 1.63.0 e fixa versões de PostgreSQL, Redis, RabbitMQ, Garage, Node, Nginx, Alpine e imagens browser.
- Promove `VERSION` e manifests para `0.2.0-alpha.2`.

### Arquivos adicionados

- `Dockerfile.garage-init` — imagem auxiliar multiarch para bootstrap do Garage.
- `garage.toml` e `deploy/templates/garage.toml` — configuração sem segredos do armazenamento.
- `prepare-env.py` — cria configuração de desenvolvimento com segredos locais únicos.
- `packages/shared/src/migrate-s3.ts` — migração repetível de objetos S3 existentes.
- `apps/manager/src/views/AccessConsole.vue` e `OperationsConsole.vue` — consoles do Manager.
- `deploy/*/{develop,production}/` — oito pacotes independentes de instalação, configuração e operações.
- `.github/workflows/ghcr-publish-application.yml`, `ghcr-sync-infrastructure.yml`, `deployment-integrity.yml` e `release.yml` — validação e distribuição.
- `docs/manager.md`, `docs/operations.md`, `deploy/README.md` e este rascunho — documentação de uso e operação.

### Arquivos modificados

- `apps/api/src/routes.ts`, `packages/shared/src/storage.ts` e `apps/manager/src/App.vue` — status operacional, armazenamento, acesso e navegação.
- `compose.yaml`, `deploy/templates/*`, `Dockerfile*` e workflows GHCR — imagens, redes, volumes, backup, publicação e verificações.
- `.env.example`, `package.json`, `pnpm-lock.yaml`, manifests workspace e `VERSION` — configuração, fluxo de desenvolvimento, dependências e alpha.
- `README.md`, `DEVELOPMENT-FLOW.md`, `docs/*`, `.github/pull_request_template.md` e arquivos de operação dos oito alvos.

### Arquivos removidos

Não se aplica a esta alteração.

### Banco de dados

Não há mudança de schema nesta alpha. As migrations existentes continuam sendo aplicadas antes da API. O script de migração S3 não apaga nem altera o bucket de origem; valide objetos e downloads antes de remover o serviço antigo.

### APIs, contratos e integrações

- `GET /v1/overview` inclui totais e taxa de sucesso das últimas 24 horas.
- `GET /v1/ops/health` requer OWNER/ADMIN e retorna `dependencies.objectStorage`, além de PostgreSQL, Redis e RabbitMQ; também retorna atividade e runtime da API.
- O armazenamento usa S3 path-style e variáveis `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_BUCKET` e `S3_REGION`.
- `pnpm storage:migrate` usa `S3_MIGRATION_SOURCE_*` para copiar de um endpoint/bucket anterior para o atual, com opção `--dry-run`.

### Dependências e configurações

- Atualiza `playwright` para `^1.63.0`; imagem Playwright `v1.63.0-noble`.
- Espelha em GHCR PostgreSQL `17.11-alpine3.23`, Redis `7.4.9-alpine`, RabbitMQ `4.3.6-management-alpine`, Garage `v2.4.1`, Alpine `3.23`, Node `24.21.0-bookworm-slim` e Nginx `1.30.5-alpine`.
- Requer os segredos de banco, fila, Garage, JWT, chave de criptografia e senha inicial OWNER. O gerador não substitui um `.env` existente.
- Requer Docker Engine/Compose v2 para bundles. CloudPanel é usado para domínio/TLS/proxy, não por API administrativa inventada.

### Segurança e privacidade

- Segredos são aleatórios por instalação; `.env` local recebe modo `0600`; nenhum segredo está versionado.
- Deploys publicam apenas o gateway em loopback. Infraestrutura não recebe mapeamento de portas.
- O health check S3 consulta bucket com credencial de aplicação e menor escopo operacional.
- A imagem browser mantém isolamento de processo, limites de CPU/memória e exigência de política de egress do host para SSRF.

### Desempenho e observabilidade

- Adiciona probes de disponibilidade e sinais operacionais de jobs, dependências, uptime e memória.
- Migração S3 usa streaming, paginação por continuation token e conferência incremental por tamanho/hash.
- Browser worker mantém limites de 2 GiB e 2 CPUs; logs dos containers são rotacionados.
- A alpha não inclui métricas Prometheus nem HA multi-nó.

### Testes implementados

Nenhum teste automatizado novo nesta alteração. A suíte existente cobre 6 casos em `test/core.test.ts`.

### Testes executados

- `pnpm typecheck` — aprovado.
- `pnpm test` — 1 arquivo e 6 testes aprovados.
- `pnpm build` — aprovado para os pacotes, API, workers e Manager.
- `pnpm format:check` — aprovado.
- Parse YAML em 19 arquivos e parse dos manifests JSON — aprovados.
- `bash -n` nos scripts de deploy, `py_compile` nos geradores e contrato estático dos oito bundles — aprovados.
- Exercício do gerador local em pasta temporária — confirmou segredos aleatórios, URLs internas consistentes e permissão `0600`.

### Testes recomendados

- Executar `docker compose config` e subir um stack em Docker Engine para validar a rede sidecar `garage-init`, o bootstrap Garage e probes S3.
- Executar fluxo HTTP e browser end-to-end, migração de um bucket de teste e ensaio completo de backup/restore.
- Homologar SSRF/egress, carga, consumo de disco, alertas e disponibilidade no host de produção.
- Executar os workflows GitHub em repositório conectado, confirmar permissões/visibilidade GHCR, arquitetura e publicação de artefatos.

### Validação manual

1. Gere `.env` com `./prepare-env.py` e confirme URL, owner e domínio.
2. Suba os serviços de infraestrutura e crie a conta OWNER; conclua MFA.
3. Crie fonte HTTP autorizada e uma fonte browser; execute, filtre, cancele job enfileirado e confira resultados/artefatos.
4. Consulte Saúde da plataforma, pause uma fonte/schedule, revogue um token e confira histórico de webhook/auditoria.
5. Para instalação antiga, rode a migração S3 com `--dry-run`, copie, confira downloads e só então remova o serviço antigo.
6. Faça backup, restaure em ambiente isolado e compare estado, artefatos e login.

### Impactos e compatibilidade

- Variáveis de armazenamento passam de `MINIO_*` para `S3_*`; a compatibilidade com bucket da alpha MinIO é tratada pelo utilitário e pelo procedimento em `docs/operations.md`.
- Bundles de produção continuam com uma única porta de aplicação. O Compose raiz possui mapeamentos apenas em loopback para desenvolvimento local por processos Node no host.
- A instalação Garage single-node não fornece redundância entre hosts. Perda do volume sem backup externo pode perder artefatos.
- Não foram observadas alterações destrutivas de banco.

### Procedimento de deploy

1. Fazer e verificar backup, sincronizar primeiro as imagens de infraestrutura para GHCR e publicar as imagens de aplicação após todos os quality gates.
2. Configurar `.env.example`, executar `prepare-env.py` e revisar dono/tag, URL HTTPS, CORS, segredo, armazenamento e visibilidade/credencial GHCR.
3. Para dados de alpha antiga, iniciar Garage sem `--remove-orphans`, executar `pnpm storage:migrate` em dry-run e depois copiar/verificar.
4. Executar `preflight.sh`, `deploy.sh`, `bootstrap.sh`; concluir MFA e verificar `/api/v1/ops/health`, coletas HTTP/browser, webhook e logs.

### Procedimento de rollback

1. Acionar rollback por erro persistente nos health checks, falha de login/coleta ou diferença de artefatos.
2. Fixar todas as imagens para o último tag funcional e reaplicar `deploy.sh`.
3. Sem mudança de schema, voltar o código não exige migration reversa; restaure `postgres.dump` e `garage.tar.gz` correspondentes se houver divergência de estado.
4. Para retorno à alpha MinIO, recriar o serviço antigo e volume a partir do backup e apontar o código anterior às credenciais/bucket de origem. Artefatos novos criados só no Garage precisam ser copiados de volta antes de remover esse volume.

### Build, release e distribuição

- Quality gates bloqueiam publicação em falha. GHCR publica runtime/aliases, Manager, docs, browser-worker e garage-init.
- Runtime/Manager/docs/garage-init: linux/amd64 e linux/arm64; browser-worker: linux/amd64.
- `develop` recebe tag `develop`; `main` exige SemVer estável e recebe versão + `stable`; GitHub Release só vem após imagens publicadas.
- Nenhum pacote, tag, release ou deploy remoto foi publicado neste ambiente.

### Documentação

README, fluxo de desenvolvimento/release, operação, deploy, Manager, arquitetura, segurança e runbooks de cada alvo foram atualizados.

### Checklist

- [x] Código, manifests e configuração foram revisados localmente.
- [x] Tipagem, testes existentes, build e formato foram executados.
- [x] O contrato estático dos oito bundles confirma bind mounts e porta de aplicação.
- [ ] Docker Compose runtime e Garage/S3 foram validados em Docker Engine.
- [ ] GHCR, release, restore de produção e carga continuam por homologar.

## Commit sugerido

`feat(scout): amplia operação, Manager e deployment GHCR`

## Merge sugerido

`merge: integra feat/scout-operational-platform-alpha-2`

## Versão sugerida

`0.2.0-alpha.2` (pré-release; a versão permanece alpha)
