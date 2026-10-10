# ARGWS Scout

**Web Intelligence & Automation Platform**

A plataforma ARGWS Scout organiza fontes web por organização e instância, executa coletas HTTP ou por navegador e entrega dados, artefatos e eventos de execução por uma API autenticada. A unidade de operação é o fluxo completo: Manager, API, banco, cache, fila, scheduler, dispatcher, workers, armazenamento, documentação e implantação.

A versão **0.6.0** evolui o Scout com convites por e-mail e ativação pelo próprio usuário, proteção da identidade principal, espaços de trabalho lógicos pessoais, perfil com foto e troca de senha, interface mais responsiva, menu Connect|API, tutoriais de primeiros passos e diagnósticos. Manager e API identificam a versão real e o commit do build no GHCR. Confira as [notas de lançamento](docs/release-v0.6.0.md). **Bancos PostgreSQL e domínios exclusivos por organização ainda não estão implementados**, conforme a [issue #30](https://github.com/wkarts/ARGWS-Scout/issues/30).

A versão **0.5.5** consolida as correções de deploy em todos os ambientes: volumes locais relativos `./volumes/` para PostgreSQL, Redis, RabbitMQ e Garage, portas externas `4xxxx`, parametrização do SMTP global de recuperação de senha e concorrência do navegador no deployer Windows 1.0.2. Inclui orientação segura para migração de volumes preexistentes e diagnóstico do estado no Dockge. Consulte o [guia de implantação e migração](docs/deployment.md).

A versão **0.5.4** corrige o provisionamento inicial do OWNER nas oito distribuições, permite diagnosticar e recuperar uma senha existente sem alterar MFA automaticamente e resolve o ciclo de reinicialização do browser-worker em hosts Docker que restringem o sandbox do Chromium. Preserva as correções do Garage da 0.5.3, os volumes e as credenciais existentes. Consulte [login e bootstrap seguro](docs/deployment.md#login-401-e-bootstrap-seguro) e [recuperação do Garage](docs/deployment.md#garage-chave-rpc-válida-e-recuperação-sem-perda-de-dados).

## O que a Scout já entrega

- Organizações multiusuário com papéis OWNER, ADMIN, OPERATOR e VIEWER.
- Login, refresh de sessão, MFA TOTP obrigatório para OWNER, gestão de usuários e reset administrativo de MFA com revogação de sessão.
- Instâncias e fontes HTTP/Playwright com allowlist de hosts e checagem SSRF em cadastro e antes da execução.
- Jobs assíncronos com outbox transacional, tentativas, cancelamento de jobs enfileirados, resultados JSON e artefatos.
- Scheduler com cron e timezone, pausa e retomada de rotinas.
- Webhooks assinados por HMAC, retries, idempotência e histórico de entrega.
- Manager WhatsApp integrado diretamente à Connect API para criar, sincronizar, parear, selecionar e remover instâncias por organização.
- Publicação manual de coletas concluídas em número escolhido, com confirmação, segredo cifrado, histórico e idempotência sem reenvio automático ambíguo.
- Tokens por instância, escopos explícitos, expiração, último uso e revogação.
- Trilha de auditoria das ações administrativas.
- Manager com dashboard de volume e taxa de sucesso em 24 horas, busca e filtros de jobs, ações por fonte, tokens, entregas, usuários, auditoria e diagnóstico de dependências.
- Containers separados para API, Manager, documentação, dispatcher, workers HTTP e browser, scheduler, webhook worker e bootstrap do Garage.
- PostgreSQL, Redis, RabbitMQ e Garage com sondagens de saúde e armazenamento persistente isolado por projeto e plataforma.

## Gerenciador

O Manager agrupa operação em Visão geral, Instâncias, Execuções, WhatsApp, Agendamentos, Webhooks, Acesso e auditoria, Saúde da plataforma e Configurações. OWNER e ADMIN administram a conexão Connect API e instâncias; OWNER, ADMIN e OPERATOR podem publicar coletas concluídas após revisar instância, telefone e mensagem. O painel de saúde testa PostgreSQL, Redis, RabbitMQ e Garage, e mostra backlog de jobs, falhas recentes, uptime e memória da API. Consulte [o guia WhatsApp](docs/whatsapp-connect-api.md) para configuração e operação.

O histórico operacional do Manager usa as rotas da API. Para uma instalação maior, logs de worker e proxy ficam nos logs dos serviços Docker; a página de saúde não substitui um stack externo de métricas e alertas.

## Estrutura do repositório

- apps/api: REST, autenticação, RBAC, auditoria, health/readiness e operações.
- apps/manager: Vue 3 + TypeScript, console de operação.
- apps/docs: documentação HTML e OpenAPI.
- apps/worker, apps/browser-worker, apps/dispatcher, apps/scheduler e apps/webhook-worker: processos isolados por função; `Dockerfile.garage-init` cria o bootstrap idempotente do armazenamento.
- packages: schemas, SDK de conectores, execução HTTP/browser, extração, core e utilitários compartilhados.
- prisma: modelo PostgreSQL, migrações e seed inicial.
- deploy/docker, deploy/dockge, deploy/cloudpanel e deploy/portainer: canais develop e production independentes.
- ops/deployment: fonte Compose e configuração operacional; pacotes de deploy sem scripts auxiliares.
- .github/workflows: quality gates, implantação, segurança, espelhamento GHCR, publicação de aplicação e release.

## Fluxo local

Requisitos: Node.js 24.21+, pnpm 11, Docker Engine e Compose v2.

1. Execute `./prepare-env.py`; ele cria `.env` com segredos aleatórios em modo `0600` e não substitui um arquivo existente.
2. Suba a infraestrutura local com `docker compose up -d postgres redis rabbitmq garage garage-init`.
3. Execute `pnpm install`, `pnpm db:generate`, `pnpm db:migrate`, `pnpm db:seed` e `pnpm exec playwright install chromium`.
4. Execute `pnpm dev` para iniciar API, Manager, dispatcher, workers HTTP/browser, scheduler e webhook worker em modo watch.
5. Abra `http://localhost:5173`; o primeiro login exige cadastro de MFA. A API fica em `localhost:8080` e os serviços de apoio aceitam conexões do host somente via loopback.

Para executar tudo em containers, use `docker compose up --build -d`, crie o OWNER com `docker compose exec api pnpm db:seed` e abra `http://127.0.0.1:48080`. Essa configuração local mantém as portas de infraestrutura presas ao loopback; os pacotes de deployment não publicam portas de banco, cache, fila ou armazenamento.

## Matriz de implantação

| Alvo           | Develop                   | Produção                     |
| -------------- | ------------------------- | ---------------------------- |
| Docker Compose | deploy/docker/develop     | deploy/docker/production     |
| Dockge         | deploy/dockge/develop     | deploy/dockge/production     |
| CloudPanel     | deploy/cloudpanel/develop | deploy/cloudpanel/production |
| Portainer      | deploy/portainer/develop  | deploy/portainer/production  |

Cada pacote contém apenas `compose.yaml` e `.env.example`. Baixe o [deployer Windows](https://github.com/wkarts/ARGWS-Scout/releases/latest) para gerar automaticamente os dois arquivos, já com segredos aleatórios; o pacote inclui interface gráfica e CLI. Para Portainer, o arquivo sai como `stack.env`, conforme o Compose desse alvo. Não há scripts do host, arquivos de configuração externos nem build no servidor. Consulte [o guia de deploy](docs/deployment.md). Docker, Dockge, CloudPanel e Portainer Standalone utilizam bind mounts locais `./volumes` ao lado do Compose efetivamente executado no host; migre volumes nomeados existentes antes de atualizar e valide o caminho real no Portainer. Cada alvo e ambiente tem seu próprio nome e porta externa do Manager em `4xxxx` (por exemplo, Dockge produção `48181`). O deployer Windows parametriza SMTP global de recuperação de senha e concorrência do browser-worker. O pacote Portainer é para Docker Standalone e carrega as variáveis do `.env.example` pelo stack; Swarm exige outro perfil.

Para instalar um alvo:

1. Docker Compose, Dockge e CloudPanel: copie `.env.example` para `.env` e preencha URL e segredos. Portainer Standalone: carregue o `.env.example` na seção de variáveis do stack.
2. Preserve `COMPOSE_PROJECT_NAME` em atualizações. Ele define nome da rede e volumes persistentes.
3. Defina `SCOUT_IMAGE_OWNER=wkarts` e escolha `SCOUT_TAG=develop` para staging ou `stable` (recomendado) ou `latest` para produção. Essa única tag atualiza as dez imagens da Scout.
4. Valide a stack com `docker compose --env-file .env -f compose.yaml config --quiet` ou use a validação do stack no Portainer.
5. Baixe e inicie os serviços com `docker compose pull` e `docker compose up -d`. O serviço `bootstrap` cria o primeiro OWNER automaticamente **apenas se o banco não possuir usuários**. Em upgrades não recria contas, não muda senhas, permissões ou MFA; confira `SCOUT_BOOTSTRAP_ADMIN_EMAIL` e `SCOUT_BOOTSTRAP_ADMIN_PASSWORD` antes da primeira instalação.

Em produção, defina `SCOUT_PUBLIC_URL` para o domínio HTTPS e mantenha a porta de loopback indicada no `.env.example`. A variável `GARAGE_RPC_SECRET` exige exatamente 64 caracteres hexadecimais (32 bytes); gere-a com `openssl rand -hex 32` e preserve-a nas atualizações. O Deployer Windows 1.0.1 corrige a geração, que anteriormente usava Base64 URL-safe e impedia o Garage de iniciar. A recuperação de instalações afetadas está descrita em [docs/deployment.md](docs/deployment.md). A chave `SCOUT_ENCRYPTION_KEY_BASE64` precisa ser gerada como Base64 de 32 bytes; a API rejeita placeholders durante a inicialização. Os pulls sem credencial exigem que os pacotes GHCR tenham leitura pública; se forem privados, configure autenticação GHCR no host antes de executar o Compose.

## Imagens e entrega

- Aplicações: argws-scout-api, argws-scout-migrate, argws-scout-dispatcher, argws-scout-worker, argws-scout-scheduler, argws-scout-webhook-worker, argws-scout-manager, argws-scout-docs, argws-scout-browser-worker e argws-scout-garage-init. Os processos Node usam o mesmo conteúdo de runtime sob tags funcionais distintas.
- Bases sincronizadas para GHCR: PostgreSQL, Redis, RabbitMQ, Garage, Alpine, Node, Nginx e Playwright.
- O fluxo de sincronização de infraestrutura roda manualmente e semanalmente; tags upstream ficam explícitas e só mudam por revisão.
- A publicação de aplicações espera todos os quality gates. develop publica somente o canal develop. main exige SemVer estável e publica a versão mais os aliases `stable` e `latest`.
- A tag Git e o GitHub Release só são criados depois que o workflow de imagens termina com sucesso.
- Runtime, Manager e docs usam linux/amd64 e linux/arm64. Browser worker usa linux/amd64 porque a imagem Playwright incluída é específica dessa arquitetura.

Na primeira sincronização, configure as permissões dos pacotes GHCR. Para pulls de produção sem token, publique os pacotes como públicos no GitHub Packages. GHCR não permite que este workflow altere sozinho a visibilidade inicial do pacote sem credencial administrativa.

## Segurança e operação

Para diagnosticar uma senha rejeitada, execute no container API `pnpm auth:diagnose`: o relatório confere a existência da conta e a correspondência entre senha do `.env` e hash persistido, sem revelar credenciais. Para recuperação sem SMTP, existe `pnpm auth:recover-owner` **somente em console interativo autorizado**, com confirmação explícita e preservação do MFA. Em hosts Docker que bloqueiam user namespaces do Chromium, o browser-worker usa `SCOUT_BROWSER_CHROMIUM_SANDBOX=false` com isolamento do contêiner; consulte os riscos e as exigências de egress em [docs/security.md](docs/security.md).

Consulte docs/security.md, docs/architecture.md e docs/operations.md. Use política de egress no host para browser worker: a validação SSRF da aplicação não substitui firewall contra redes privadas e metadados de nuvem. Configure cópia externa dos backups e faça ensaio de restauração; os scripts não executam backup agendado por conta própria.

## Limites atuais

Esta versão ainda não inclui cofre externo de credenciais, catálogo hospedado de conectores, retenção automática de artefatos, federação SSO, métricas Prometheus, alta disponibilidade multi-nó ou prova de carga de produção. Senhas de integração e tokens são limitados ao modelo atual. Não colete conteúdo sem autorização ou fora das regras do site de origem.

ARGWS Scout é um produto separado. Não importa runtime, banco, fila, autenticação ou código de ARGWS Connect|API; a comparação com Connect|API foi usada para melhorar a operação, o Manager e o fluxo de distribuição.
