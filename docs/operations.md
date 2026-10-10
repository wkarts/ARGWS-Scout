# Operação

## Perfis de instalação

O Compose raiz é o ambiente de desenvolvimento local e mapeia Postgres, Redis, RabbitMQ e S3 somente para loopback para permitir os processos Node em modo watch. Os pacotes GHCR de deploy ficam separados em deploy/docker, deploy/dockge, deploy/cloudpanel e deploy/portainer, cada um com develop e production. Cada pacote tem somente Compose e `.env.example`; use [o guia de deploy](deployment.md) para preencher segredos, inicializar OWNER, atualizar e fazer backup/restauração.

Em produção, use domínio HTTPS, SCOUT_COOKIE_SECURE=true, SCOUT_ALLOW_HTTP=false, CORS restrito e SCOUT_TRUST_PROXY_HOPS compatível com o proxy. Só Manager publica porta e o bind é 127.0.0.1. CloudPanel termina TLS e encaminha para o gateway.

## E-mail

Configure `SCOUT_RECOVERY_SMTP_HOST`, `PORT`, `SECURE`, `USERNAME`, `PASSWORD`, `FROM_EMAIL` e `FROM_NAME` no `.env` para redefinição de senha. Esse relay é global e usado apenas para recuperação; mantenha seu segredo no mesmo cofre do `.env`. Cada organização configura seu SMTP de envio em **Configurações** do Manager, separado do relay de recuperação. `SECURE=true` representa TLS implícito; com `false`, a API exige STARTTLS. A integração por organização é testável pelo painel e a senha fica cifrada com `SCOUT_ENCRYPTION_KEY_BASE64`.

## Serviços e verificação

O stack contém API, Manager, docs, Postgres, Redis, RabbitMQ, Garage, migração, dispatcher, worker HTTP, browser worker, scheduler e webhook worker. As sondagens da API verificam Postgres e Redis para readiness; a área Saúde da plataforma verifica também RabbitMQ e Garage. Containers têm política de restart, healthchecks onde a imagem suporta e limites de log. Todas as oito distribuições utilizam bind mounts locais `./volumes` para PostgreSQL, Redis, RabbitMQ e Garage (config/meta/data). Instalações anteriores com volumes nomeados precisam copiar os dados antes da troca; no Portainer confirme o diretório real do Compose no host.

Comandos úteis na raiz para desenvolvimento: `docker compose ps`, `docker compose logs -f api dispatcher worker browser-worker scheduler webhook-worker` e `docker compose exec api pnpm db:seed`. Em Dockge/Portainer use o estado e os logs do stack. Os pacotes publicados não dependem de scripts hospedados no servidor.

## Identidade do build no GHCR

O Manager e a API exibem a versão SemVer do pacote e também o canal e o prefixo SHA da revisão de código usada no build. Os argumentos `SCOUT_GIT_SHA` e `SCOUT_CHANNEL` são injetados pelo workflow de publicação e não dependem de valores antigos do `.env`. Se o painel indicar versões ou SHAs diferentes entre Manager e API, atualize a stack usando **uma mesma revisão** para todos os serviços de aplicação.

A tag móvel `develop` pode manter o mesmo SemVer durante o desenvolvimento, mas seu SHA muda a cada publicação. As tags estáveis `0.5.x` devem apontar para uma revisão imutável; `stable` e `latest` são aliases atualizados por release.

## Diagnóstico e retenção de eventos

O Scout registra erros HTTP autenticados em uma tabela de diagnóstico separada por espaço de trabalho, com identificador de requisição, método, rota e status. O endpoint `GET /api/v1/ops/diagnostics` fornece visão resumida dos últimos sete dias; as listas de eventos individuais são limitadas para não sobrecarregar o painel, mas os contadores exibem os totais.

A consulta `GET /api/v1/ops/diagnostics/events?days=7&limit=200` fornece eventos em ordem decrescente. Quando `nextCursor` não for `null`, repita a solicitação com `cursor=<nextCursor>` para percorrer todo o histórico retido. Os filtros aceitam até 30 dias, status HTTP 400–599 e até 200 eventos por página. Somente administradores autenticados podem consultar o próprio espaço.

```dotenv
SCOUT_DIAGNOSTIC_RETENTION_DAYS=30
LOG_LEVEL=info
```

A retenção padrão de erros HTTP é de 30 dias e pode ser parametrizada de 7 a 365 dias. A limpeza é feita pelo scheduler, aproximadamente a cada 24 horas. Logs de containers são outra fonte: consulte API, Manager, dispatcher, workers e scheduler no Dockge/Portainer e preserve backups externos dos logs importantes. Os arquivos `json-file` têm rotação configurada no Compose, que não equivale à centralização de logs.

**Limite da implementação atual:** os eventos persistidos não constituem um coletor centralizado e pesquisável de stdout/stderr de todos os contêineres. O pacote exportado pelo painel é uma visão sanitizada e limitada; para suporte completo são necessários logs de containers mais trilhas de jobs, auditoria e webhooks. Nunca anexe o `.env` nem senhas, tokens, dados privados ou segredos da Connect|API a relatórios compartilhados.

## Limites funcionais por serviço

- API: limite global de 120 requests/minuto por chave/IP em Redis; login tem limite menor.
- HTTP: timeout 20 s, resposta até 2 MiB, intervalo mínimo de 1 s por fonte.
- Browser: timeout 30 s, Chromium isolado em container dedicado, screenshot até 500 KB, limite de 2 GiB e 2 CPUs.
- Webhook: timeout 10 s, resposta até 64 KiB, até oito tentativas com backoff limitado.
- Aumente workers HTTP com Compose scale após validar limites da base, fila, Garage e destino remoto.

## Rede do browser

A validação SSRF bloqueia loopback, endereços privados conhecidos e redirects para destino não permitido. Isso não fornece firewall de saída para o processo Chromium. Aplique política de egress no host para bloquear redes internas, endpoints de metadados e DNS rebinding; mantenha allowlists por fonte. Não use autorização do usuário final como única barreira contra acesso a infraestrutura.

## Backups e restauração

Os pacotes Compose não executam backups automáticos nem incluem scripts de restauração. Configure no host um processo de backup consistente do PostgreSQL e dos diretórios persistentes do Garage, com aplicações e consumidores coordenados quando necessário. Replicar ./backups para armazenamento externo cifrado, definir retenção e ensaiar restore em ambiente isolado. Redis e RabbitMQ guardam estado operacional recuperável; a estratégia de backup deve seguir o SLA do ambiente.

A restauração deve ser ensaiada em uma cópia isolada antes de substituir dados da produção. Preserve os volumes originais até verificar integridade dos backups, acessos e artefatos. Não execute `docker compose down -v`. Proteja o arquivo .env e backups com o mesmo cuidado que credenciais de aplicação.

### Migração das versões anteriores que usavam MinIO

Faça e confira um backup antes da mudança. Para a migração, mantenha o serviço `minio` antigo ativo enquanto inicia somente `garage` e `garage-init` com o Compose novo, sem `--remove-orphans`. O container antigo e o novo Garage ficam na rede isolada do projeto.

Defina temporariamente `S3_MIGRATION_SOURCE_ENDPOINT=http://minio:9000`, `S3_MIGRATION_SOURCE_BUCKET`, `S3_MIGRATION_SOURCE_ACCESS_KEY_ID`, `S3_MIGRATION_SOURCE_SECRET_ACCESS_KEY` e, se necessário, `S3_MIGRATION_SOURCE_REGION` no ambiente do operador. Rode `docker compose --env-file .env -f compose.yaml run --rm --no-deps -e S3_MIGRATION_SOURCE_ENDPOINT -e S3_MIGRATION_SOURCE_BUCKET -e S3_MIGRATION_SOURCE_ACCESS_KEY_ID -e S3_MIGRATION_SOURCE_SECRET_ACCESS_KEY -e S3_MIGRATION_SOURCE_REGION api pnpm storage:migrate --dry-run` para conferir a contagem. Remova `--dry-run` para copiar. A rotina preserva as chaves e metadados, transmite objetos em fluxo sem carregá-los todos na memória, verifica tamanho e SHA-256, e pode ser reexecutada. Depois de validar resultados e downloads, execute o deploy completo; ele remove o serviço antigo como órfão. O bucket de origem fica intacto até essa etapa.

## Atualização e rollback

Quality gates validam migrações, seed, tipagem, testes, build, formato e os oito Compose antes da publicação de aplicação. Runtime/Manager/docs são multiarch amd64/arm64; Playwright é amd64. O canal develop usa tag fixo develop. main exige SemVer estável e publica versão + stable após os gates. Release Git só ocorre depois que as imagens foram publicadas.

Para voltar versão, selecione o tag funcional anterior em todas as imagens do .env, implante e verifique /api/v1/ops/health, login/MFA, uma execução HTTP, uma browser e um webhook. Faça rollback de código antes de migration destrutiva; nesse caso restaure o backup consistente correspondente.
