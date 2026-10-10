# Refinamento de conteúdo e publicações — Scout v0.8.0

> **Estado:** módulo opcional da v0.8.0, desligado por padrão. Testes Python/TypeScript/Prisma, compilação e validação de Compose fazem parte dos Quality Gates; testes de ponta a ponta com integrações reais exigem homologação específica antes de ativar em produção. A instalação não envia publicações automaticamente.

## Escopo e compatibilidade

- Acrescenta fluxo opcional **Coleta → Normalização → Identidade → Observações → Artes → Rascunhos → Revisão**; jamais modifica `Job.result` nem remove um motor HTTP/browser, webhook, scheduler, Connect API ou publicação WhatsApp anterior.
- Um refinamento é processado por `apps/content-worker` (Node/RabbitMQ) consumindo `content.refine` da outbox. `apps/content-engine` (Python/FastAPI/Pillow) gera arquivos temporários privados que são transferidos para o **Garage/S3 existente**; histórico, metadados, rascunhos e revisões ficam no PostgreSQL via Prisma.
- Isolamento: o `tenantId` vem da sessão autenticada, o `instanceId` delimita o catálogo; todas as APIs consultam os itens por tenant e relacionamentos. A identidade de um item pode reaparecer em diferentes coletas da mesma instância, sem eliminar observações históricas; outras instâncias mantêm identidades separadas.
- Rascunhos por canal: WhatsApp, e-mail HTML/EML, Telegram, Facebook, Instagram, LinkedIn, SMS, PNG quadrado/horizontal/story. **Nenhum envio é realizado automaticamente**: a geração e aprovação não disparam mensagem e não alteram os envios já existentes.
- Normalizadores conservadores para envelopes de scraping Scout (`data.links`, `data.text`, `data.value`), extração HTTP e navegador, produtos do KaBuM!, listas JSON genéricas e JSON-LD/schema.org (Product/Offer, Article/NewsArticle, Event, Service, JobPosting, Recipe, RealEstateListing, LocalBusiness, Course etc.), HTML com OG. A arquitetura é genérica, mas não implica 100% de precisão para qualquer site arbitrário; layouts incomuns exigem adaptadores ou regras configuradas.
- Nos cartões novos, o coletor captura `image_url` quando a foto está contida em `<a>`, OG e JSON-LD. Capturas antigas do KaBuM! podem não ter URLs de mídia: nesse caso a arte é sinalizada como **ilustrativa**, nunca substituída por foto aleatória.

## Ativar em uma instalação

1. Faça backup de PostgreSQL, volumes e Garage/S3; mantenha **COMPOSE_PROJECT_NAME**, volumes, domínio e `SCOUT_TAG` originais. Publique as **12 imagens** no GHCR pelo fluxo CI antes de referenciá-las em produção.
2. No ambiente da stack, crie chave independente para o serviço privado: `openssl rand -hex 32` e defina `SCOUT_CONTENT_ENGINE_KEY=<valor-gerado>`. Configure `SCOUT_CONTENT_ENABLED=true`, `COMPOSE_PROFILES=content` (junto com outros perfis utilizados, separados por vírgula, se aplicável). As configurações padrão permanecem desabilitadas.
3. Aplique a migração Prisma `20261010220000_content_refinement_and_publications` através do serviço `migrate` existente. Ela adiciona tabelas/enums sem remover nem reestruturar dados legados.
4. Em develop local: `docker compose --profile content up -d --build content-engine content-worker` e reinicie a API/dispatcher/worker para propagação do recurso. Para deploy remoto, substitua o compose da plataforma escolhida pelo respectivo arquivo desta entrega, preencha variáveis e execute `docker compose --profile content pull` / `docker compose --profile content up -d` preservando dados. Para Portainer Standalone, `stack.env` deve continuar presente e ser corretamente carregado.
5. Entre no Manager → **Publicações** → escolha a instância. Ative `autoProcess` **somente se desejar refinamento após novas coletas**. É possível importar retorno JSON ou refinar um Job com status `SUCCEEDED` manualmente. Revise divergências, pré-visualize imagens e aprove individualmente. `SCOUT_CONTENT_ENABLED=false` desativa o processamento mantendo os dados.
6. Confirme separadamente política de egress do host, permissões de fotos e conformidade LGPD/direitos autorais e limites de uso de cada marketplace. Captura de imagem é desabilitada por padrão. Não processe sites que proíbem sua automação.

### Operação por plataforma

- `compose.yaml` na raiz: opção de build local sem porta pública para o Python.
- `deploy/docker/{develop,production}`, `deploy/dockge/{develop,production}`, `deploy/cloudpanel/{develop,production}` e `deploy/portainer/{develop,production}`: serviço opcional `content-engine` (GHCR) e `content-worker` (imagem de runtime GHCR, processo próprio). Todo tráfico passa pela rede privada do Compose. Os oito pacotes contêm apenas `compose.yaml` e `.env.example`.
- `ops/deployment/compose.yaml` é um modelo operacional histórico, não um dos oito pacotes independentes de deploy GHCR. Para uma instalação efetiva, selecione o Compose específico da plataforma.

## API autenticada do Scout (`/api/v1`, servidor OpenAPI `/v1`)

| Método    | Rota                               | Função                                                                |
| --------- | ---------------------------------- | --------------------------------------------------------------------- |
| GET       | `/content/status`                  | Estado do recurso/canais sem revelar a chave privada                  |
| GET/PATCH | `/content/instances/{id}/settings` | Configurações por instância (alteração OWNER/ADMIN)                   |
| GET       | `/content/jobs?instanceId={uuid}`  | Jobs concluídos disponíveis                                           |
| POST      | `/content/jobs/{jobId}/refine`     | Criar/enfileirar refinamento de coleta existente                      |
| POST      | `/content/import`                  | Importar JSON arbitrário em uma fonte/instância autorizadas           |
| GET       | `/content/batches`                 | Lotes da organização/instância                                        |
| GET       | `/content/batches/{id}`            | Lote e registros refinados                                            |
| GET       | `/content/identities/{id}/history` | Preços/observações históricas                                         |
| PATCH     | `/content/items/{id}/review`       | `DRAFT`, `APPROVED` ou `ARCHIVED` (divergências requerem ADMIN/OWNER) |
| GET       | `/content/items/{id}/export`       | JSON com textos/links/status sem disparo                              |
| GET       | `/content/items/{id}/media/{kind}` | PNG privado `square`,`wide`,`story` ou EML `eml`                      |

Todas as rotas requerem sessão do Manager; as rotas de criação têm rate limiting; importação limita JSON a 2 MiB. A API Python interna tem autenticação de segredo independente, rede interna e limite de 5 MiB por entrada. Não publique a porta Python no proxy reverso.

### Importar retorno genérico

Exemplo de corpo de `POST /api/v1/content/import`, usando IDs válidos de uma fonte existente **na mesma instância**:

```json
{
  "instanceId": "00000000-0000-4000-8000-000000000001",
  "sourceId": "00000000-0000-4000-8000-000000000002",
  "payload": {
    "requestedUrl": "https://loja.exemplo.com/ofertas",
    "finalUrl": "https://loja.exemplo.com/ofertas",
    "capturedAt": "2026-10-10T20:21:02Z",
    "data": {
      "items": [
        {
          "id": "SKU-001",
          "title": "Item demonstrativo",
          "price": "123.45",
          "currency": "BRL",
          "url": "https://loja.exemplo.com/produto/1"
        }
      ]
    }
  },
  "options": {
    "maxItems": 100,
    "createStory": true,
    "fetchImages": false,
    "enrichImages": false
  }
}
```

A identidade `id + domínio + instância` é utilizada para histórico e evitar duplicação acidental. Os rascunhos de capturas distintas permanecem distintos. Campos incorretos não são corrigidos silenciosamente; preços, descontos e imagens sem fonte confiável são mantidos com aviso/revisão. O retorno deve ser tratado como dado não confiável.

## Permissões, privacidade e segurança

- Criar lote/importar, aprovar e arquivar: OWNER, ADMIN, OPERATOR; **aprovação de itens com alertas de revisão:** OWNER/ADMIN. Somente OWNER/ADMIN alteram configurações da instância.
- O Python não conhece credenciais de clientes, WhatsApp, destinatários, SMTP de recuperação, cookies de autenticação ou a Connect API. Worker privado usa apenas segredo próprio e S3/DB necessários. Não há telemetria adicionada, analytics externo ou rastreamento comercial neste módulo.
- Downloads opcionais de mídia só por HTTPS e IP público com verificação de redirecionamento; **também é necessário aplicar políticas de egress em Docker/host**. A capacidade de consultar páginas para enriquecer imagens é desativada por padrão e não garante disponibilidade das fotos reais.
- Segredos devem ficar nos `.env` do servidor; nunca embuta em imagens, fontes JavaScript, exports ou logs. Aprovação não equivale a consentimento de envio; encaminhamento a destinatários depende de fluxo autorizado e independente.

## Limites e próximos testes necessários

- Testes do Python unitários/integrados concluídos; **os Quality Gates, migrations, build e Compose devem ser aprovados para publicação; ainda são necessários testes operacionais ponta a ponta com RabbitMQ/Garage na instalação do cliente**. Publicação do GHCR e GitHub Release é controlada pelo pipeline, separada do deploy da VPS.
- Sem fila de campanhas, sem agendamento ou disparos em massa nesta integração. O módulo gera rascunhos individuais; publicação/exposição externa deve ser uma capacidade posterior com autorização por canal, consentimento do destinatário, idempotência e quotas.
- A revisão de produtos pode apontar divergência de título e URL e descontos, mas capturas antigas sem metadados de imagem continuarão com arte ilustrativa.
- O diagnóstico enviado identifica dois jobs Mercado Livre com `COLLECTION_FAILED`, três tentativas cada; o JSON não inclui stack trace nem mensagem de origem, portanto este módulo não corrige nem diagnostica sozinho os bloqueios da coleta.
