# ARGWS Scout v0.6.1 — Notas de lançamento

A v0.6.1 sucede a v0.6.0. Consolida correções de layout, conexão única da Connect|API e visualização de documentação online, preservando contas, MFA, convites, instâncias, coletas e os dados locais existentes.

## Melhorias

- **Responsividade:** rodapé reposicionado no fluxo correto do Manager, eliminando a faixa lateral vazia no desktop e o estreitamento indevido em celulares; testes Chromium com larguras de 320 a 1920 pixels.
- **Connect|API global:** uma URL e um token administrativos, parametrizados em `SCOUT_CONNECT_API_URL` e `SCOUT_CONNECT_API_TOKEN` no arquivo de ambiente. Somente a API recebe essas credenciais; os workers não têm acesso aos segredos globais.
- **Instâncias particulares:** espaços administram apenas as próprias instâncias WhatsApp; nomes remotos exclusivos, reivindicação de propriedade por vínculo, token particular cifrado e sincronização restrita, sem expor canais de outros espaços.
- **Migração segura:** registros antigos da conexão por organização permanecem intactos para rollback; os vínculos antigos precisam ser revalidados com token particular após a troca para a conexão global. Não transferir automaticamente instâncias externas.
- **Documentação navegável:** `/docs/` aponta OpenAPI e manuais Markdown para `/docs/viewer.html?doc=...`, com leitura renderizada, busca por endpoints e contratos visualizados no próprio navegador. Sem redirecionar o usuário para downloads de arquivos `.yaml` ou `.md`, sem dependências CDN. Os arquivos de origem continuam disponíveis para acesso programático.
- **Versão e OpenAPI:** identificação SemVer alinhada a `0.6.1`, incluindo o contrato OpenAPI exposto pelos documentos.

## Regras de atualização

1. Faça **backup consistente do PostgreSQL, Garage e `.env`** e teste o processo de recuperação.
2. Preserve o `COMPOSE_PROJECT_NAME`, os dados locais em `./volumes`, credenciais individuais, sessões e MFA. Nunca use `docker compose down -v`.
3. Configure o `.env` da stack com `SCOUT_CONNECT_API_URL=https://...` e `SCOUT_CONNECT_API_TOKEN=...`; use HTTPS. Mantenha `SCOUT_MANAGER_PORT=48181` no Dockge Production.
4. Atualize todos os serviços de aplicação para a versão `0.6.1` e aplique as migrações aditivas, especialmente a reserva de instâncias remotas por espaço. Reinicie a API e o Manager; o serviço docs é atualizado com a mesma versão.
5. Para cada espaço com instâncias antigas, revalide o vínculo usando **o token particular daquela instância**. Confira conexão, QR e permissões antes de publicar.
6. Confirme o layout em desktop/mobile e abra `/docs/viewer.html?doc=openapi` e `/docs/viewer.html?doc=architecture` para testar a documentação navegável. Consulte as execuções, histórico de mensagens, agenda, auditoria e recuperação de senha.

## Limitações preservadas

Os espaços continuam separados **logicamente** na base PostgreSQL compartilhada. **Bancos dedicados e domínios exclusivos não estão implementados**; isso permanece na [issue #30](https://github.com/wkarts/ARGWS-Scout/issues/30). A visualização OpenAPI é destinada à consulta de endpoints; não dispara chamadas de produção pelo navegador.

A publicação das imagens no GitHub/GHCR **não atualiza automaticamente a stack em execução na VPS**.

## Evidência de publicação

A versão estável deve passar pelos Quality Gates, segurança, integridade, teste de viewport, publicação GHCR de `0.6.1`, `stable` e `latest`, `verify-published` e geração da GitHub Release `v0.6.1` com os binários Windows e `SHA256SUMS.txt`.
