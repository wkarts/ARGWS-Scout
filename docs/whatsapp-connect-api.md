# Manager WhatsApp com Connect API

A área **WhatsApp** do Manager administra uma instalação dedicada da Connect API por organização Scout. A Scout conversa com ela pelo backend: o navegador nunca recebe a chave administrativa.

## Configurar a conexão

1. Abra **WhatsApp** no Manager com perfil OWNER ou ADMIN.
2. Informe a URL pública HTTPS da Connect API e a chave administrativa (`apikey`).
3. Selecione **Testar e salvar**. A Scout valida a chave listando as instâncias existentes e guarda a chave cifrada no PostgreSQL.
4. Use **Sincronizar** para atualizar instâncias, estado de conexão e tokens retornados pela Connect API.

A URL precisa apontar para um host público HTTPS. A política de rede da Scout bloqueia HTTP, hosts privados/locais, portas fora de 443 e redirecionamentos para outros hosts. Endpoints com caminho de proxy, como `https://connect.exemplo.com/api`, são aceitos.

O segredo usa a chave já existente `SCOUT_ENCRYPTION_KEY_BASE64`. Preserve seu valor em todas as réplicas e faça backup seguro junto com o banco; trocar essa chave sem migrar os segredos torna a configuração e os tokens cifrados ilegíveis.

## Instâncias

- **Nova instância** cria uma instância WhatsApp Baileys na Connect API e gera um token próprio aleatório. A Scout cifra esse token antes de persistir.
- **Conectar / QR** pede à Connect API o QR ou código de pareamento. **Estado**, **Reiniciar** e **Desconectar** usam o token daquela instância.
- **Vincular existente** valida um token próprio com `GET /instance/fetchInstances?instanceName=...` e o guarda cifrado. A chave administrativa não é usada como substituto do token da instância.
- **Sincronizar** mantém o catálogo da organização alinhado ao endpoint configurado. Uma instância removida remotamente deixa de ser selecionável; o histórico de publicações é preservado.
- O OWNER ou ADMIN pode definir uma instância padrão. Cada publicação ainda permite escolher explicitamente outra instância.
- **Excluir** remove a instância remota permanentemente pela API administrativa e exige confirmação no Manager.

Os nomes e estados são metadados visíveis à organização. A chave administrativa e tokens de instância nunca são retornados nas rotas Scout.

## Publicar uma coleta

Uma coleta com estado `SUCCEEDED` pode ser aberta no Manager e enviada pelo WhatsApp. O editor preenche uma mensagem inicial com os dados coletados; o operador escolhe a instância, informa o número com DDI e revisa o texto antes de confirmar. O destino precisa ter de 8 a 15 dígitos depois de normalizar o formato internacional. A mensagem aceita até 4.096 caracteres.

OWNER, ADMIN e OPERATOR podem publicar. VIEWER pode consultar o catálogo e o histórico. O histórico guarda número e mensagem cifrados e exibe somente os quatro últimos dígitos do destino. Cada envio exige `Idempotency-Key` única por organização. Repetir a mesma chave retorna o resultado já salvo e não envia de novo.

Os estados `SENT`, `FAILED` e `UNKNOWN` descrevem o retorno observado. Timeout, desconexão ou erro HTTP 5xx podem ocorrer depois que a Connect API aceitou a mensagem; por isso a Scout marca `UNKNOWN`, não repete o envio automaticamente e orienta conferir a conversa no WhatsApp antes de tentar novamente. Uma tentativa manual nova usa uma chave idempotente nova.

## Deploy, migração e rollback

Não há um container, script de deploy, variável de ambiente ou serviço adicional para a integração. Configure endpoint e chave no Manager após atualizar a versão. A migração PostgreSQL aditiva é aplicada pelo comando já presente nos Compose (`pnpm db:migrate`) antes da API. Ela cria configuração, catálogo de instâncias e histórico, sem alterar jobs existentes.

Para rollback de código, volte a imagem anterior e mantenha as tabelas adicionadas; elas não impedem a versão anterior de iniciar. Não remova as tabelas enquanto desejar preservar o histórico. Uma troca da chave de criptografia requer um plano de recifragem dos dados.

## Contrato da Connect API usado

| Ação na Scout               | Endpoint Connect API                                                                    | Credencial enviada         |
| --------------------------- | --------------------------------------------------------------------------------------- | -------------------------- |
| Testar/sincronizar catálogo | `GET /instance/fetchInstances`                                                          | chave administrativa       |
| Criar instância             | `POST /instance/create`                                                                 | chave administrativa       |
| Parear/consultar estado     | `GET /instance/connect/{instanceName}` e `GET /instance/connectionState/{instanceName}` | token próprio da instância |
| Reiniciar/desconectar       | `POST /instance/restart/{instanceName}` e `DELETE /instance/logout/{instanceName}`      | token próprio da instância |
| Excluir instância           | `DELETE /instance/delete/{instanceName}`                                                | chave administrativa       |
| Publicar texto              | `POST /message/sendText/{instanceName}`                                                 | token próprio da instância |

A autenticação nativa da Connect API usa o cabeçalho `apikey`. Todas as chamadas partem da API Scout; o Manager só chama rotas `/v1/whatsapp` protegidas pela sessão Scout.
