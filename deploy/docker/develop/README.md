# ARGWS Scout — docker — develop

Pacote de instalação independente com Compose, configuração, bootstrap, atualização, diagnóstico e recuperação.
Os dados ficam em bind mounts relativos em ./volumes. PostgreSQL, Redis, RabbitMQ e Garage não publicam portas no host.

## Instalação

1. Revise .env.example; ajuste domínio, e-mail do OWNER e owner/tag de cada imagem GHCR.
2. Rode ./prepare-env.py, depois revise .env. Segredos são criados localmente; .env recebe permissão 0600.
3. Rode ./preflight.sh e ./deploy.sh.
4. Rode ./bootstrap.sh uma vez. A senha inicial está em .env; MFA é exigido no primeiro acesso.
5. Para domínio, configure SCOUT_PUBLIC_URL, SCOUT_COOKIE_SECURE=true e SCOUT_ALLOW_HTTP=false.
6. O único bind publicado é 127.0.0.1:8080. O CloudPanel termina TLS e encaminha ao gateway Manager.

## Operação

- ./status.sh mostra saúde dos containers e logs recentes.
- ./backup.sh pausa consumidores e gera dump PostgreSQL consistente e snapshot Garage em ./backups/.
- ./restore.sh --confirm-replace-current-data ./backups/TIMESTAMP restaura dados e mantém o Garage anterior em uma pasta de recuperação.
- Para rollback, selecione o tag anterior nas imagens funcionais do .env, rode ./deploy.sh e verifique /api/v1/ops/health.
- GHCR privado: deploy.sh aceita GHCR_USERNAME e GHCR_TOKEN como variáveis temporárias; o Docker config temporário é removido ao sair.

## Docker Engine

Execute scripts nesta pasta com Docker Engine e Compose v2. Faça cópia externa periódica de ./backups/ e ./volumes/.

## Escopo e segurança

O browser worker usa até 2 GiB e precisa de saída para sites autorizados. A defesa SSRF da aplicação bloqueia destinos locais conhecidos; configure também política de egress no host para redes privadas e metadados de nuvem. A imagem Playwright é linux/amd64.
Imagens funcionais: runtime, manager, docs e browser-worker. Bases GHCR: PostgreSQL, Redis, RabbitMQ, Garage, cliente Garage, Node, Nginx e Playwright.
