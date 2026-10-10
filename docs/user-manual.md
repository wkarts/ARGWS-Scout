# Manual de utilização do Scout

## Objetivo

O Scout consulta fontes web autorizadas, coleta informações estruturadas, agenda monitoramentos, registra resultados e permite comunicar descobertas por canais externos integrados. Não é um navegador de vídeo ou downloader de conteúdos protegidos. A integração com Connect|API centraliza o canal WhatsApp atual e permite adicionar outros canais no futuro, sem transformar o Scout em plataforma de mensageria.

## Permissões

- **Proprietário:** administra os recursos da organização, define integrações e pode recuperar MFA de outros membros, exceto da identidade principal protegida da instalação.
- **Administrador:** convida pessoas, gerencia configurações e consulta auditoria do espaço permitido.
- **Operador:** executa coletas, publica resultados quando autorizado e acompanha rotinas.
- **Leitor:** consulta informações permitidas, sem modificar configurações críticas.

A conta principal configurada pelo servidor é protegida no banco e na API; não aparece na listagem de usuários da organização e não pode receber redefinição de MFA nem cadastro administrativo sobreposto. A senha inicial do servidor não é transmitida à API nem aos trabalhadores permanentes; somente o serviço de provisionamento recebe a credencial. A própria conta ainda pode gerenciar seu perfil e alterar sua senha com confirmação da senha atual.

## Menu da plataforma

| Área                | Função                                            |
| ------------------- | ------------------------------------------------- |
| Visão geral         | Indicadores, tarefas recentes e estado do espaço  |
| Instâncias          | Agrupamento de fontes e resultados                |
| Execuções           | Enfileiramento, histórico, artefatos e publicação |
| Connect\|API       | Integração com canais de comunicação, inicialmente WhatsApp |
| Agendamentos        | Regras cron de coleta periódica                   |
| Webhooks            | Recebimento de eventos por sistemas externos      |
| Configurações       | SMTP da organização e opções operacionais         |
| Acesso e auditoria  | Convites, papéis e trilha administrativa          |
| Saúde da plataforma | Dependências e diagnóstico exportável             |
| Primeiros passos    | Assistente guiado da primeira coleta ao envio     |

## Canais de comunicação

A Connect|API usa URL e token administrativos **globais configurados somente no servidor**. Cada espaço administra e visualiza suas próprias instâncias WhatsApp, seus tokens e seus envios; uma instância não aparece em outro espaço. O administrador pode criar uma instância e conectar pelo QR Code. Para instâncias antigas ou importadas, precisa validar o token particular; o token global nunca é exibido no Manager. Consulte [Configuração Connect|API](whatsapp-connect-api.md).

## Perfis e e-mails

A recuperação de senha usa o SMTP global próprio, configurado no servidor. Convites para a organização e envio de resultados usam o SMTP configurado para aquela organização. O administrador não conhece a senha criada pelo convidado. Por padrão, convites concedem um **espaço independente** para quem for convidado; o administrador pode escolher acesso de equipe ao espaço atual. Ambos ainda compartilham a infraestrutura de banco físico até a migração arquitetural. Convites expiram em 48 horas e podem ser cancelados.

## Segurança e privacidade

As mensagens enviadas passam por confirmação explícita. Tokens de API e segredos de webhooks aparecem apenas na criação. Requerer HTTPS em produção e proteção de MFA. Nunca publicar cookies de sessão, segredos, senhas, códigos 2FA ou dumps do ambiente em chamados de suporte.

## Suporte e diagnósticos

O relatório da área Saúde contém falhas HTTP sanitizadas, dados resumidos de tarefas e histórico de atividades nos últimos sete dias. Retenção de eventos técnicos HTTP: 30 dias por padrão, configurável de 7 a 365 dias. Logs completos dos processos permanecem no mecanismo de logging do Docker e devem ser coletados/retidos conforme a operação da VPS.

**Limitação importante:** a arquitetura atual separa organizações logicamente em um único PostgreSQL. Domínio próprio e database-per-organization são objetivos de expansão, não funcionalidades concluídas.
