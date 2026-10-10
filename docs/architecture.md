# Arquitetura

## Responsabilidades

```text
Manager → REST API → PostgreSQL + Outbox → Dispatcher → RabbitMQ
                                                   ├→ HTTP Worker
                                                   ├→ Browser Worker → Playwright/Chromium
                                                   └→ Webhook Worker → sistemas externos

Scheduler → PostgreSQL/Outbox → Dispatcher
```

- **Manager:** Vue 3, autenticação de usuário, tenant ativo, configuração e leitura de resultados.
- **API:** Fastify, contratos Zod/OpenAPI, sessões, autorização, tenants, instâncias, fontes, jobs, auditoria e integração server-to-server com Connect API. Não carrega Chromium.
- **PostgreSQL:** fonte de verdade para tenant, memberships, configurações, jobs, tentativas, schedules, tokens, webhooks, outbox, credenciais Connect API cifradas e histórico cifrado de publicação.
- **Outbox/Dispatcher:** job e evento de domínio são gravados com a alteração de estado no banco; o dispatcher publica de forma repetível. Consumers fazem claim condicional e idempotente.
- **HTTP Worker:** requests limitados, URL/redirect/robots/SSRF validados, extração de HTML/JSON.
- **Browser Worker:** imagem/container separado com Playwright e recursos próprios.
- **Scheduler:** cron/timezone cria jobs e outbox em transação; atualização condicional impede dois schedulers de lançar a mesma ocorrência.
- **Webhook Worker:** HMAC-SHA256, idempotency-key, timeout, histórico e retry com backoff.
- **Redis:** rate limit compartilhado da API e reserva de intervalo por fonte nos workers.
- **Garage/S3:** screenshots e artifacts; downloads passam pela API autorizada em streaming.

## Hierarquia de dados

`Tenant → Membership → Instance → Source → Job → JobAttempt/Artifact`. Uma instância é um nome, slug, descrição e metadata sem semântica de provedor. Ela pode reunir fontes de vários sites; conectores podem ser reutilizados com configurações distintas.

## Independência

Não há pacote, imagem, banco, fila ou código da ARGWS Connect API no grafo de dependências/deploy da Scout. A integração Connect|API é opcional e usa uma única URL e token administrativos configurados por `SCOUT_CONNECT_API_URL` e `SCOUT_CONNECT_API_TOKEN` no ambiente da API Scout. Cada espaço tem sua própria reserva de nomes remotos de instância e tokens particulares cifrados; a sincronização e os comandos ficam restritos aos vínculos previamente autorizados. O backend não lista instâncias globais da Connect|API para usuários.

## Entrega

RabbitMQ e Outbox dão entrega pelo menos uma vez. Consumers fazem claim condicional e repetem operações com chave estável. O dispatcher recupera jobs RUNNING sem heartbeat por 120 segundos, reenfileirando tentativas ou encerrando após o limite configurado.
