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
- **API:** Fastify, contratos Zod/OpenAPI, sessões, autorização, tenants, instâncias, fontes, jobs e auditoria. Não carrega Chromium.
- **PostgreSQL:** fonte de verdade para tenant, memberships, configurações, jobs, tentativas, schedules, tokens, webhooks e outbox.
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

Não há pacote, autenticação, banco, fila, imagem ou código da ARGWS Connect API no grafo de dependências da Scout. Sistemas externos integram-se pelos mesmos contratos REST e Webhooks.

## Entrega

RabbitMQ e Outbox dão entrega pelo menos uma vez. Consumers fazem claim condicional e repetem operações com chave estável. O dispatcher recupera jobs RUNNING sem heartbeat por 120 segundos, reenfileirando tentativas ou encerrando após o limite configurado.
