# Deploy ARGWS Scout

Cada pacote em `deploy/{docker,dockge,cloudpanel,portainer}/{develop,production}` tem somente `compose.yaml` e `.env.example`. Não há scripts do host, configuração montada nem build no servidor. Os serviços usam imagens GHCR.

## Instalação

Copie `.env.example` para `.env`, preencha URL e segredos, valide com `docker compose --env-file .env -f compose.yaml config --quiet`, baixe as imagens e suba a stack com `pull` e `up -d`. Crie o OWNER uma vez com `docker compose --env-file .env -f compose.yaml --profile maintenance run --rm bootstrap`. MFA é obrigatório no primeiro acesso. Os pulls sem credencial exigem pacotes GHCR com leitura pública; caso sejam privados, configure a autenticação GHCR no host antes do pull.

O Manager publica somente `127.0.0.1:8080`; CloudPanel termina TLS e encaminha o domínio para essa porta. PostgreSQL, Redis, RabbitMQ e Garage ficam na rede Compose e persistem em volumes relativos. Garage usa configuração inline no Compose; nenhum `garage.toml` é necessário. Requisito: Docker Compose v2.23.1+.

## Bases e fluxo

A publicação chama o workflow reutilizável de espelhamento GHCR antes de compilar. O workflow sincroniza Node, Nginx, Playwright, Alpine, BuildKit, PostgreSQL, Redis, RabbitMQ e Garage; preserva os mirrors existentes no fluxo normal, atualiza semanalmente as tags de versão fixada e aceita refresh manual por dispatch com `refresh_existing=true`.

`develop` publica o canal de teste. Uma PR revisada de `develop` para `main` publica SemVer e canal estável após os gates. O BuildKit mantém cache por componente e limpa caches próprios sem acesso há duas horas depois de publicação validada. Tags, imagens de release e histórico de releases não são alvos dessa limpeza.

Use `docker compose ps`, `logs`, `exec` e `run` para operação. Faça backup do banco e do volume Garage antes de atualizar e teste a restauração em homologação.
