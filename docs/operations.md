# Operação

## Perfis de instalação

O Compose raiz é o ambiente de desenvolvimento local e mapeia Postgres, Redis, RabbitMQ e S3 somente para loopback para permitir os processos Node em modo watch. Os pacotes GHCR de deploy ficam separados em deploy/docker, deploy/dockge, deploy/cloudpanel e deploy/portainer, cada um com develop e production. Cada pacote tem somente Compose e `.env.example`; use [o guia de deploy](deployment.md) para preencher segredos, inicializar OWNER, atualizar e fazer backup/restauração.

Em produção, use domínio HTTPS, SCOUT_COOKIE_SECURE=true, SCOUT_ALLOW_HTTP=false, CORS restrito e SCOUT_TRUST_PROXY_HOPS compatível com o proxy. Só Manager publica porta e o bind é 127.0.0.1. CloudPanel termina TLS e encaminha para o gateway.

## Serviços e verificação

O stack contém API, Manager, docs, Postgres, Redis, RabbitMQ, Garage, migração, dispatcher, worker HTTP, browser worker, scheduler e webhook worker. As sondagens da API verificam Postgres e Redis para readiness; a área Saúde da plataforma verifica também RabbitMQ e Garage. Containers têm política de restart, healthchecks onde a imagem suporta e limites de log. Docker, Dockge e CloudPanel usam bind mounts relativos; Portainer usa volumes nomeados com prefixo do projeto.

Comandos úteis na raiz para desenvolvimento: `docker compose ps`, `docker compose logs -f api dispatcher worker browser-worker scheduler webhook-worker` e `docker compose exec api pnpm db:seed`. Em Dockge/Portainer use o estado e os logs do stack. Os pacotes publicados não dependem de scripts hospedados no servidor.

## Limites funcionais por serviço

- API: limite global de 120 requests/minuto por chave/IP em Redis; login tem limite menor.
- HTTP: timeout 20 s, resposta até 2 MiB, intervalo mínimo de 1 s por fonte.
- Browser: timeout 30 s, Chromium isolado em container dedicado, screenshot até 500 KB, limite de 2 GiB e 2 CPUs.
- Webhook: timeout 10 s, resposta até 64 KiB, até oito tentativas com backoff limitado.
- Aumente workers HTTP com Compose scale após validar limites da base, fila, Garage e destino remoto.

## Rede do browser

A validação SSRF bloqueia loopback, endereços privados conhecidos e redirects para destino não permitido. Isso não fornece firewall de saída para o processo Chromium. Aplique política de egress no host para bloquear redes internas, endpoints de metadados e DNS rebinding; mantenha allowlists por fonte. Não use autorização do usuário final como única barreira contra acesso a infraestrutura.

## Backups e restauração

Os scripts de deploy fazem dump PostgreSQL e snapshot Garage em diretório versionado por timestamp. Eles pausam API e consumidores durante a cópia. Replicar ./backups para armazenamento externo cifrado, definir retenção e ensaiar restore em ambiente isolado. Redis e RabbitMQ guardam estado operacional recuperável; a estratégia de backup deve seguir o SLA do ambiente.

Restauração substitui o banco corrente e requer flag explícita --confirm-replace-current-data. A pasta Garage anterior é mantida como recuperação local. Proteja o arquivo .env e backups com o mesmo cuidado que credenciais de aplicação.

### Migração das versões anteriores que usavam MinIO

Faça e confira um backup antes da mudança. Para a migração, mantenha o serviço `minio` antigo ativo enquanto inicia somente `garage` e `garage-init` com o Compose novo, sem `--remove-orphans`. O container antigo e o novo Garage ficam na rede isolada do projeto.

Defina temporariamente `S3_MIGRATION_SOURCE_ENDPOINT=http://minio:9000`, `S3_MIGRATION_SOURCE_BUCKET`, `S3_MIGRATION_SOURCE_ACCESS_KEY_ID`, `S3_MIGRATION_SOURCE_SECRET_ACCESS_KEY` e, se necessário, `S3_MIGRATION_SOURCE_REGION` no ambiente do operador. Rode `docker compose --env-file .env -f compose.yaml run --rm --no-deps -e S3_MIGRATION_SOURCE_ENDPOINT -e S3_MIGRATION_SOURCE_BUCKET -e S3_MIGRATION_SOURCE_ACCESS_KEY_ID -e S3_MIGRATION_SOURCE_SECRET_ACCESS_KEY -e S3_MIGRATION_SOURCE_REGION api pnpm storage:migrate --dry-run` para conferir a contagem. Remova `--dry-run` para copiar. A rotina preserva as chaves e metadados, transmite objetos em fluxo sem carregá-los todos na memória, verifica tamanho e SHA-256, e pode ser reexecutada. Depois de validar resultados e downloads, execute o deploy completo; ele remove o serviço antigo como órfão. O bucket de origem fica intacto até essa etapa.

## Atualização e rollback

Quality gates validam migrações, seed, tipagem, testes, build, formato e os oito Compose antes da publicação de aplicação. Runtime/Manager/docs são multiarch amd64/arm64; Playwright é amd64. O canal develop usa tag fixo develop. main exige SemVer estável e publica versão + stable após os gates. Release Git só ocorre depois que as imagens foram publicadas.

Para voltar versão, selecione o tag funcional anterior em todas as imagens do .env, implante e verifique /api/v1/ops/health, login/MFA, uma execução HTTP, uma browser e um webhook. Faça rollback de código antes de migration destrutiva; nesse caso restaure o backup consistente correspondente.
