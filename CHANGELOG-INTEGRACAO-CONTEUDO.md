# Integração candidata — Scout 0.7.0 + refinamento e publicações

Data da análise: 2026-10-10. **Sem alteração de `VERSION`, sem merge, sem release GHCR e sem deploy.**

## Implementado no código entregue

- Captura enriquecida não destrutiva (links com imagens, JSON-LD, Open Graph) nos motores existentes.
- Normalização Python genérica com adaptador KaBuM!, imagens opcionais (HTTPS/IP público), gráficos Pillow e textos para vários canais.
- API Python isolada com token de serviço e teto de payload, sem portas publicadas; worker RabbitMQ com recuperação de falhas e persistência Garage.
- Schema e migração Prisma com lotes, identidades isoladas por instância, versões de captura, observações de preços, textos e artefatos.
- API `/v1/content/*` autenticada + seção `Publicações` no Manager, fluxo de revisão manual e exportação.
- Serviços opcionais em Compose raiz e nas 8 combinações de implantação, bases/imagens GHCR adicionadas ao workflow.
- Documentação navegável, rotas OpenAPI, testes Python.

## Não implementado / não validado

- Envio automático/campanhas em WhatsApp/SMTP/Telegram; nenhuma publicação enviada.
- Garantia de extração exata para qualquer domínio; parser genérico é heurístico e extensível.
- Atualização ou conserto comprovado dos dois jobs Mercado Livre `COLLECTION_FAILED` reportados no diagnóstico.
- PR/merge/release GHCR e instalação de produção.
- Verificação `pnpm`/Prisma/Docker de ponta a ponta, pendente no ambiente com dependências e containers.

## Backups e segurança

Mantenha `COMPOSE_PROJECT_NAME`, volumes persistentes, arquivos do Garage e credenciais já operantes. Configure `SCOUT_CONTENT_ENABLED`, `COMPOSE_PROFILES` e segredo interno conforme docs/content-refinement.md. Para produção, valide Prisma migrate deploy, builds Docker, acesso às 12 imagens GHCR, testes de API/front e rollback.
