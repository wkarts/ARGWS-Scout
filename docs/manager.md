# Manager operacional

O Manager é o console web para equipes que operam várias instâncias e fontes.

## Áreas

- Visão geral: totais persistidos de instâncias, fontes e jobs; fila, execução ativa, taxa de sucesso 24h e jobs recentes.
- Instâncias: fontes, execuções, schedules, webhooks e tokens por instância.
- Execuções: busca por instância/fonte, filtro de estado, detalhe de resultado, artefatos e cancelamento enquanto o job ainda está na fila.
- Connect|API: conexão global configurada no `.env` do servidor, com criação e gestão de instâncias WhatsApp particulares por espaço; QR de pareamento, estado, reinício, desconexão, exclusão e preferência de publicação por espaço.
- Publicações: enviar resultado de uma coleta concluída para número escolhido, editar a mensagem pré-preenchida e consultar estado no histórico.
- Fontes: habilitar/pausar e disparar coleta HTTP ou Playwright.
- Agendamentos: habilitar/pausar expressões cron e revisar timezone/próxima ocorrência.
- Webhooks: revisar destino e eventos, inspecionar últimas 100 entregas e seus retries.
- Tokens: rever prefixo, escopos, expiração e último uso; revogar sem revelar segredo.
- Acesso e auditoria: convidar por e-mail, ativação e escolha de senha pelo próprio usuário, com papéis; a conta principal protegida não pode ser gerenciada por outras contas; OWNER/ADMIN consultam eventos permitidos.
- Configurações: ativar TOTP, guardar/regenerar códigos reserva de uso único, recuperar a senha por e-mail e gerenciar o SMTP de envio separado por organização. OWNER/ADMIN podem enviar um e-mail de teste.
- Saúde da plataforma: probes de PostgreSQL, Redis, RabbitMQ e Garage, mais fila, falhas 24h, uptime, versão e memória da API.

O segredo completo de token de API e de webhook só é exibido no momento de criação. Armazene esses valores em cofre externo. O Manager aplica os papéis fornecidos pela API; ocultar controles na interface não substitui autorização no servidor.

O SMTP de recuperação não aparece como uma integração editável por tenant: configure o relay global `SCOUT_RECOVERY_SMTP_*` no ambiente do deploy. O SMTP de envio de cada organização pode ser configurado em **Configurações**; a senha salva é cifrada e não pode ser consultada de volta. Porta 465 usa TLS implícito; outras portas usam STARTTLS obrigatório.

O painel é responsivo e construído em Vue 3 + TypeScript. As áreas de acesso e operações são componentes isolados em src/views; o app shell mantém navegação, sessão e fluxos principais. Logs detalhados por serviço permanecem no runtime Docker e podem ser consultados por Dockge, Portainer ou linha de comando.

A URL e o token administrativos da Connect|API são globais e ficam **somente nas variáveis `SCOUT_CONNECT_API_URL` e `SCOUT_CONNECT_API_TOKEN` do contêiner API**; não são editados por usuários. Os tokens individuais WhatsApp ficam cifrados no banco por espaço com `SCOUT_ENCRYPTION_KEY_BASE64`. OWNER/ADMIN administram suas instâncias, OPERATOR publica e VIEWER só consulta. O Manager nunca recebe os segredos globais. O contrato, o modelo de idempotência e o procedimento de atualização estão em [WhatsApp com Connect API](whatsapp-connect-api.md).
