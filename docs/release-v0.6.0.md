# ARGWS Scout v0.6.0 — Notas de lançamento

A versão 0.6.0 sucede a v0.5.5 e incorpora a evolução homologada na PR #29, preservando os fluxos anteriores de instâncias, coleta, agendamentos, webhooks, publicação pela Connect|API e infraestrutura Docker.

## Evolução funcional

- **Identidade principal protegida:** cadastro inicial marcado de forma persistente, ocultação da identidade nas listagens administrativas delegadas, bloqueio de redefinição de MFA por outras contas e senha de bootstrap acessível somente ao serviço temporário de provisionamento.
- **Convites e espaços pessoais:** e-mails com token de uso único e validade de 48 horas; senha escolhida pelo destinatário; acesso compartilhado opcional ou criação de espaço pessoal lógico com instância inicial; alternância autorizada entre espaços.
- **Perfil:** foto privada, atualização de dados pessoais, troca de senha própria, proteção das sessões e MFA.
- **Experiência:** menu Connect|API no lugar de WhatsApp como nome do recurso, melhoria de responsividade e legibilidade, correções de modais e permissões de tokens com seleção individual.
- **Identificação de build:** versão SemVer, canal e SHA do Git apresentados no Manager e na API, com aviso de divergências e política de cache apropriada.
- **Diagnósticos e documentação:** registros sanitizados de erros HTTP com requestId, totais e paginação, retenção parametrizável, exportação JSON, manual completo e tutorial de primeira coleta e publicação.
- **Infraestrutura:** importação de chaves no Garage tolera caracteres iniciais de hífen, com validação dos manifestos e preservação das portas 4xxxx e volumes relativos.

## Limites conhecidos

**Espaços pessoais são isolados logicamente no PostgreSQL compartilhado. Banco dedicado, domínio individual, migração física e isolamento integral de infraestrutura por organização ainda não estão implementados** e permanecem acompanhados na [issue #30](https://github.com/wkarts/ARGWS-Scout/issues/30). O diagnóstico no painel não substitui a coleta centralizada de stdout/stderr de todos os contêineres.

## Atualização segura

1. Fazer backup consistente do PostgreSQL, Garage e configuração atual; testar a restauração.
2. Manter `COMPOSE_PROJECT_NAME`, preservar `./volumes` e evitar `docker compose down -v`, limpeza de volumes ou troca de credenciais existentes.
3. Revisar os manifests e o arquivo de ambiente, inclusive `SCOUT_DIAGNOSTIC_RETENTION_DAYS=30`. A porta padrão do Manager no Dockge Production permanece `48181`.
4. Atualizar todos os serviços de aplicação à versão `0.6.0` e executar as migrações Prisma aditivas antes de inicializar API/Manager, seguindo a ordem de dependências do Compose.
5. Validar login/MFA, proteção da conta principal, convites/SMTP, espaços pessoais e instância inicial, coleta HTTP e browser, Connect|API, envios, webhooks, healthchecks e exportação de diagnósticos.
6. Repetir backup após a verificação dos dados existentes.

## Critérios de publicação

O tag `v0.6.0` só é aprovado depois da passagem de `develop` para `main`, Quality Gates, Security, Deployment Integrity, verificação GHCR de todas as tags `0.6.0`, `stable`, `latest` e geração dos artefatos Windows com arquivo `SHA256SUMS.txt`.

**Publicação no GitHub/GHCR não altera automaticamente a stack em execução na VPS.**
