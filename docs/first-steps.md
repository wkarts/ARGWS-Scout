# Primeiros passos — da primeira coleta à publicação

Este guia ensina a utilizar o Scout sem conhecimento prévio de programação.

## 1. Acesse sua conta

Entre com e-mail e senha. Se o autenticador for solicitado, registre-o e guarde os códigos de recuperação em um cofre seguro. Se você recebeu um convite, use o link original para escolher **sua própria senha** (mínimo de 16 caracteres); não envie sua senha ao administrador.

## 2. Entenda os recursos

- **Espaço de trabalho:** área de acesso e dados compartilhados com sua equipe.
- **Instância:** agrupa fontes e resultados para um cliente, finalidade ou processo.
- **Fonte:** site público ou endpoint HTTP autorizado que será consultado.
- **Execução:** uma coleta realizada agora ou agendada.
- **Resultado:** dados extraídos, JSON e, quando permitido, capturas de tela.
- **Connect|API:** integração com os canais de comunicação. O canal disponível nesta versão é WhatsApp.
- **Publicação:** envio de um resultado concluído a um destinatário, mediante confirmação.

## 3. Crie sua primeira instância

Abra **Instâncias → Nova instância**. Informe o nome, por exemplo **Monitoramento de site**, e uma descrição. A instância agrupará suas fontes.

## 4. Cadastre uma fonte pública segura

Na instância criada, abra **Fontes → Adicionar fonte**:

| Campo                | Exemplo             |
| -------------------- | ------------------- |
| Nome                 | Página de exemplo   |
| Mecanismo            | HTTP                |
| URL                  | https://example.org |
| Hosts permitidos     | example.org         |
| Seletor opcional     | h1                  |
| Respeitar robots.txt | Sim                 |
| Intervalo mínimo     | 5000 ms             |

**Observação:** use somente páginas que você tem autorização para consultar e respeite políticas de acesso, direitos autorais, robots.txt e limites de tráfego. O Scout não deve ser utilizado para contornar login, paywall, DRM ou proteção de streaming. A visualização de um player de vídeo, por exemplo, não concede licença para copiá-lo.

## 5. Execute a coleta

Abra **Execuções → Nova execução**, selecione a fonte e confirme. A tarefa entra na fila; seu estado pode ser **Na fila**, **Executando**, **Concluído** ou **Falhou**. Abra a execução concluída para conferir o JSON e os artefatos.

Caso não obtenha resultado: confira a URL, se o host está autorizado, o mecanismo HTTP ou navegador, a conexão com a página, e o seletor. Sites com conteúdo renderizado por JavaScript podem exigir o mecanismo **Navegador**.

## 6. Configure Connect|API e publique

No menu **Connect|API**, conecte a plataforma e associe a instância WhatsApp que enviará mensagens. Faça o pareamento necessário e confirme que o canal está disponível. Volte a **Execuções**, abra um resultado **Concluído** e escolha **Publicar pelo WhatsApp**. Selecione a instância conectada, informe o número com código do país e DDD, revise o texto e confirme.

**O envio é uma ação explícita.** Caso a confirmação falhe ou seja indeterminada, confira o histórico da Connect|API antes de tentar novamente para evitar mensagens duplicadas.

## 7. Automatize

Em **Agendamentos**, escolha uma fonte e configure a regra cron e o fuso horário. O scheduler enfileirará as coletas nos horários configurados. Em **Webhooks**, cadastre destinos HTTPS confiáveis para receber eventos assinados com HMAC, quando necessário.

## 8. Convide alguém

Acesse **Acesso e auditoria**, configure primeiro o SMTP de **envio da organização** em Configurações e preencha nome, e-mail e papel. O convidado receberá um link de ativação válido por 48 horas. Administradores não definem a senha do convidado. Um convite existente pode ser cancelado antes de ser usado.

Uma conta com acesso a mais de um espaço pode alternar pelo seletor no alto do menu lateral.

## 9. Seu perfil

Abra o menu da conta para atualizar nome, telefone e foto. A foto é redimensionada e armazenada no armazenamento privado configurado. Use **Alterar senha** para confirmar a senha atual e definir outra; sessões antigas serão revogadas. O menu não oferece escolha de idioma: a experiência está em Português do Brasil.

## 10. Consulte diagnósticos

Em **Saúde da plataforma**, veja a versão efetiva da API, dependências (PostgreSQL, Redis, RabbitMQ e Garage), tarefas na fila e falhas recentes. Utilize **Exportar diagnóstico JSON** para obter indicadores, logs HTTP sanitizados, falhas de tarefas, entregas e ações administrativas dos últimos sete dias. Registros não incluem corpos de requisição, tokens ou senhas.

Para logs detalhados de execução e falhas de inicialização, um operador autorizado pode consultar os logs dos containers no Dockge/Portainer, sem exportar credenciais.

## Ainda não disponível como isolamento físico

Os espaços atuais têm segregação lógica por organização no banco PostgreSQL compartilhado. **Bancos dedicados, domínios exclusivos e provisionamento isolado por conta não foram concluídos**; o plano técnico está em [Evolução de isolamento](./workspace-isolation.md). Não considere o isolamento por conta equivalente a um banco dedicado até a infraestrutura e a migração terem sido homologadas.
