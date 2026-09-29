# Deployments ARGWS Scout

A pasta deploy contém oito pacotes independentes. Cada alvo tem um diretório por canal; não há um Compose único com caminhos absolutos ou named volumes.

| Alvo       | Desenvolvimento    | Produção              | Responsabilidade                |
| ---------- | ------------------ | --------------------- | ------------------------------- |
| Docker     | docker/develop     | docker/production     | Compose v2 diretamente no host  |
| Dockge     | dockge/develop     | dockge/production     | Stack gerenciada pelo Dockge    |
| CloudPanel | cloudpanel/develop | cloudpanel/production | TLS e proxy reverso do domínio  |
| Portainer  | portainer/develop  | portainer/production  | Stack gerenciada pelo Portainer |

Cada pacote tem seu compose.yaml, .env.example, prepare-env.py, preflight.sh, deploy.sh, bootstrap.sh, status.sh, backup.sh, restore.sh e README.md. deploy/templates contém a fonte comum e os pacotes gerados são verificados pela CI.

## Topologia

A porta do Manager é publicada somente em 127.0.0.1. O Manager serve a interface e encaminha /api para API e /docs para documentação. PostgreSQL, Redis, RabbitMQ e Garage ficam na rede privada do Compose sem mapeamento de portas. API, migração, dispatcher, workers, scheduler e webhook worker usam imagens GHCR distintas. A imagem Playwright é separada e limitada a linux/amd64.

PostgreSQL, Redis, RabbitMQ e Garage persistem em ./volumes/<serviço>. Cada alvo e canal usa projeto/rede Compose próprios, configuração independente e segredos gerados no servidor.

## Fluxo de instalação

1. Se ainda não existirem, execute os workflows GHCR infrastructure images e GHCR application images na ordem documentada em DEVELOPMENT-FLOW.md.
2. Revise os valores de imagem e tag em .env.example.
3. Execute prepare-env.py para gerar .env local com modo 0600.
4. Revise URL pública, conta OWNER e opções TLS.
5. Execute preflight.sh para validar engine, Compose, segredos, bind mounts e loopback.
6. Execute deploy.sh para pull e atualização.
7. Execute bootstrap.sh uma vez para criar o tenant OWNER e conclua MFA no primeiro login.

Para pacotes GHCR privados, use credenciais efêmeras no deploy.sh: GHCR_USERNAME e GHCR_TOKEN. A rotina as mantém em Docker config temporário durante pull/deploy e apaga o diretório temporário ao terminar. Dockge ou Portainer precisam de credencial própria configurada no host caso as imagens permaneçam privadas.

## Recuperação e atualização

backup.sh interrompe consumidores, grava pg_dump em formato custom e arquiva Garage. O diretório backups deve ser replicado para armazenamento externo cifrado. Restaure em janela de manutenção com restore.sh --confirm-replace-current-data ./backups/<timestamp>; a pasta Garage anterior é movida para um diretório local de recuperação.

Atualizações rodam migrations antes da API por dependência Compose. Para rollback, altere as imagens funcionais para o tag anterior no .env, execute deploy.sh e teste login/MFA, saúde, coleta HTTP, coleta Playwright e webhooks. Migrations destrutivas exigem restauração de backup.

CloudPanel é usado somente para domínio, TLS e proxy reverso. O Docker Compose continua como runtime; a Scout não depende de endpoint administrativo não documentado do CloudPanel.
