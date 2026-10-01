# Manager operacional

O Manager é o console web para equipes que operam várias instâncias e fontes.

## Áreas

- Visão geral: totais persistidos de instâncias, fontes e jobs; fila, execução ativa, taxa de sucesso 24h e jobs recentes.
- Instâncias: fontes, execuções, schedules, webhooks e tokens por instância.
- Execuções: busca por instância/fonte, filtro de estado, detalhe de resultado, artefatos e cancelamento enquanto o job ainda está na fila.
- WhatsApp: conexão tenant-scoped com a Connect API, sincronização e criação de instâncias, QR de pareamento, estado/reinício/desconexão/exclusão e instância padrão.
- Publicações: enviar resultado de uma coleta concluída para número escolhido, editar a mensagem pré-preenchida e consultar estado no histórico.
- Fontes: habilitar/pausar e disparar coleta HTTP ou Playwright.
- Agendamentos: habilitar/pausar expressões cron e revisar timezone/próxima ocorrência.
- Webhooks: revisar destino e eventos, inspecionar últimas 100 entregas e seus retries.
- Tokens: rever prefixo, escopos, expiração e último uso; revogar sem revelar segredo.
- Acesso e auditoria: criar usuário com senha inicial longa e papel; OWNER pode redefinir MFA de outro membro; OWNER/ADMIN consultam eventos.
- Saúde da plataforma: probes de PostgreSQL, Redis, RabbitMQ e Garage, mais fila, falhas 24h, uptime, versão e memória da API.

O segredo completo de token de API e de webhook só é exibido no momento de criação. Armazene esses valores em cofre externo. O Manager aplica os papéis fornecidos pela API; ocultar controles na interface não substitui autorização no servidor.

O painel é responsivo e construído em Vue 3 + TypeScript. As áreas de acesso e operações são componentes isolados em src/views; o app shell mantém navegação, sessão e fluxos principais. Logs detalhados por serviço permanecem no runtime Docker e podem ser consultados por Dockge, Portainer ou linha de comando.

A chave administrativa da Connect API e os tokens individuais WhatsApp ficam cifrados no banco com `SCOUT_ENCRYPTION_KEY_BASE64`. OWNER/ADMIN configuram e administram a integração; OPERATOR publica; VIEWER só consulta. O Manager nunca lê os segredos de volta. O contrato, o modelo de idempotência e o procedimento de atualização estão em [WhatsApp com Connect API](whatsapp-connect-api.md).
