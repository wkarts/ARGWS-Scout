# ARGWS Scout v0.8.0 — Refinamento e publicações

A v0.8.0 sucede a v0.7.0 e consolida a evolução do motor opcional de processamento de conteúdo, sem substituir as coletas HTTP/browser, a Connect|API ou os modelos prontos existentes.

## Novidades

- **Refinamento por instância:** normalização conservadora de resultados JSON, HTML e JSON-LD; preserva `Job.result` original e dados antigos.
- **Histórico e identidade:** relaciona itens de capturas sucessivas à mesma instância; registra observações e divergências sem excluir dados anteriores.
- **Mídia opcional:** gera PNG quadrado, horizontal e story, e-mails HTML/EML e rascunhos de textos por canal, com artefatos privados no Garage/S3. Captura externa de imagens exige ativação e regras de rede.
- **Revisão humana:** estados de rascunho, aprovação e arquivamento; permissões para evitar aprovações automáticas de resultados incertos.
- **Processamento assíncrono:** `content-worker` Node e `content-engine` Python/FastAPI/Pillow opcionais, via RabbitMQ/outbox. API externa protegida, sem nova porta pública.
- **Administração e documentação:** área de Publicações no Manager, configurações por instância, importação JSON, monitoramento de lotes, exportação de rascunhos e visualização online em `/docs/viewer.html?doc=content-refinement`.
- **Connect|API:** operações de administração do WhatsApp com token particular e proteção entre espaços, preservando histórico e exclusão controlada da instância. A integração anterior permanece.
- **Qualidade:** regressão de responsividade em Chromium, validação dos oito deployments, testes TypeScript/Prisma/Python e geração do deployer Windows.

## Funcionamento e limites

**O módulo não efetua disparos automáticos de WhatsApp, e-mail, Telegram ou redes sociais.** Ele prepara rascunhos para revisão e eventuais integrações explicitamente autorizadas. Não declare suporte completo a envio nos canais ainda não implementados. O processamento é **desabilitado por padrão** e exige configuração `SCOUT_CONTENT_ENABLED=true` e perfil Compose `content`.

Fontes devem ser autorizadas, respeitar robots.txt, acesso, direitos autorais, limites e privacidade. Modelos Mercado Livre, Shopee, Amazon, Magalu e demais marketplaces são modelos de pesquisa editáveis, não APIs oficiais com autenticação. O isolamento permanece lógico no PostgreSQL compartilhado; bancos e domínios exclusivos continuam pendentes na [issue #30](https://github.com/wkarts/ARGWS-Scout/issues/30).

## Instalação segura

1. Faça backup consistente do PostgreSQL, Garage, `.env`, credenciais e volumes `./volumes`, incluindo ensaio de restauração.
2. Preserve `COMPOSE_PROJECT_NAME`, todas as identidades/senhas existentes, seus dados e portas `4xxxx`. No Dockge Production, a porta padrão permanece `48181`. Nunca use `docker compose down -v`.
3. Substitua o Compose pelo perfil correspondente da v0.8.0 e confira as imagens GHCR. Atualize todos os serviços da aplicação para a mesma tag `0.8.0`.
4. Execute migrações Prisma aditivas antes de iniciar os serviços dependentes e confira os healthchecks.
5. Sem ativação explícita, o motor opcional fica parado. Para homologar, gere um `SCOUT_CONTENT_ENGINE_KEY` forte, defina `SCOUT_CONTENT_ENABLED=true` e inicie o perfil `content` com `COMPOSE_PROFILES=content`. Não exponha a porta interna do Python externamente.
6. Teste login/MFA, espaços, modelos, fonte de busca, fila RabbitMQ, Garage/S3, histórico, rascunhos, revisão, Connect|API, documentação online e casos de falha. Faça novo backup depois de confirmar o funcionamento.

A instalação Docker/Dockge/CloudPanel/Portainer em execução **não é atualizada automaticamente** pela publicação no GitHub ou no GHCR.

## Homologação e rastreabilidade

A tag estável `v0.8.0` exige promoção revisada `develop → main`, Quality Gates, segurança, integridade dos Compose, verificação de todos os manifests GHCR `0.8.0`, `stable` e `latest`, e executáveis Windows com `SHA256SUMS.txt`. O relatório CI não substitui teste de ponta a ponta na VPS, especialmente quando o motor opcional for habilitado.

Consulte [Refinamento de conteúdo](content-refinement.md), [Modelos de instâncias](instance-templates.md) e [Implantação](deployment.md).
