# Connect|API — conexão única e canais independentes por espaço

O Scout utiliza **uma única Connect|API** para a instalação inteira. A URL e o token administrativos são configurados exclusivamente no `.env` do servidor, carregado somente pela API. Nenhum administrador de espaço de trabalho consegue consultar, modificar ou receber o token global pelo Manager.

## Configuração do servidor

```dotenv
SCOUT_CONNECT_API_URL=https://connect.exemplo.com.br
SCOUT_CONNECT_API_TOKEN=INSIRA_UM_TOKEN_ADMINISTRATIVO_SEGURO
```

A URL deve ser HTTPS, sem usuário/senha, query string ou fragmento. Não preencha essa chave em formulários web, dados da organização, cookies ou javascript do navegador. O backend utiliza `apikey` no header das requisições externas. Chaves são carregadas pelo contêiner `api` a partir de `.env`/ `stack.env`; os serviços de migração, bootstrap e workers recebem valores vazios em substituição à variável de ambiente.

Para aplicar alterações: na pasta da stack, faça backup do `.env`, configure os dois campos, valide o Compose e recrie o **api** após aplicar as migrations. No Dockge, a porta pública de produção continua `48181` e os dados continuam em `./volumes`. Não altere `COMPOSE_PROJECT_NAME`.

## O que cada pessoa administra

Uma conexão **não** significa compartilhar as instâncias WhatsApp. Cada espaço só lista, conecta, reinicia, desconecta e publica pelas suas próprias instâncias, vinculadas em banco ao seu identificador. Outros espaços não enxergam seus números nem seus tokens. Operadores com permissões adequadas podem publicar nas instâncias do espaço, mas não alterar o token global.

**Criar nova instância:** abra **Connect|API → Nova instância**, informe um nome amigável e faça o pareamento. O Scout cria um nome remoto com prefixo exclusivo do espaço e sufixo aleatório para evitar colisões no servidor global. Um token particular aleatório é gerado e cifrado no banco do Scout. A URL e o token globais jamais chegam ao browser.

**Atualizar minhas instâncias:** essa ação consulta o estado somente das instâncias previamente vinculadas ao espaço usando o token particular de cada uma. O Scout **não consulta nem importa em massa** a lista global de instâncias da Connect|API, impedindo que um espaço copie tokens ou informações de outros.

**Vincular existente:** exige nome remoto e token particular válido. A API verifica o vínculo por token e reserva o nome remoto globalmente para um único espaço. Se já pertencer a outro espaço, a operação é bloqueada. Uma credencial administrativa global nunca pode ser usada como token particular.

**Revalidar vínculo antigo:** após migrar de uma configuração por organização para o servidor global, registros existentes continuam salvos, mas ficam indisponíveis até que o responsável informe novamente o token particular. A revalidação evita interpretar dados de Connect APIs antigas como propriedade válida na nova conexão.

**Excluir:** somente administradores do espaço podem excluir as próprias instâncias vinculadas. A publicação exige coleta concluída do mesmo espaço, instância vinculada, número válido e chave de idempotência para evitar duplicidade.

## Migração sem perda de dados

1. Faça backup consistente de PostgreSQL, Garage, `.env` e configurações existentes, incluindo a tabela legada `ConnectApiConfig`.
2. Configure o `.env` global e aplique a migration `20261010020000_global_connect_workspace_claims`, que adiciona a tabela de propriedade, nome amigável e preferência de instância por espaço. Ela **não apaga os registros nem as credenciais antigas**.
3. Recrie a API (e o Manager atualizado) sem apagar `./volumes`.
4. Em cada espaço, use **Revalidar vínculo** ou **Vincular existente** com o token particular. Revalide antes de usar uma instância antiga ou efetuar publicações.
5. Confirme o estado do WhatsApp, receba mensagens de teste e valide que outra organização não enxerga nem consegue operar a instância.
6. Só após backup testado e migração confirmada planeje a limpeza controlada de dados legados sensíveis. **Não elimine automaticamente os dados antigos na migration.**

As configurações antigas de URL e token por organização permanecem armazenadas **apenas para recuperação/rollback**, mas não são mais utilizadas para conectar, listar ou operar instâncias. A edição pelo Manager foi desativada; `PUT /v1/whatsapp/config` responde `410`.

## Contratos da integração

| Operação                                      | Política                                                                   |
| --------------------------------------------- | -------------------------------------------------------------------------- |
| `GET /v1/whatsapp`                            | Configuração global disponível (sim/não) e instâncias do espaço, sem token |
| `POST /v1/whatsapp/instances`                 | Cria instância remota de nome exclusivo e token particular cifrado         |
| `POST /v1/whatsapp/sync`                      | Atualiza apenas instâncias reivindicadas pelo espaço                       |
| `POST /v1/whatsapp/instances/import`          | Vincula instância com token particular, se livre                           |
| `POST /v1/whatsapp/instances/claim`           | Revalida nome remoto e token informado pelo responsável                    |
| `PUT /v1/whatsapp/default`                    | Salva a preferência de envio somente para o espaço                         |
| `POST /v1/whatsapp/instances/{name}/{action}` | Status, QR, reiniciar e desconectar somente de instância reivindicada      |
| `DELETE /v1/whatsapp/instances/{name}`        | Exclui instância reivindicada sem afetar outros espaços                    |
| `POST /v1/whatsapp/publications`              | Publicação idempotente de coleta concluída pelo próprio espaço             |

O mecanismo de propriedade é garantido por uma reserva única de nome remoto no PostgreSQL. O token particular é criptografado. Isso constitui isolamento **lógico** de canais: banco e domínio físicos exclusivos continuam pendentes na [issue #30](https://github.com/wkarts/ARGWS-Scout/issues/30).

A plataforma Connect|API poderá atender outros canais futuramente, como Instagram, mas não é correto afirmar que esses canais já estão integrados ao Scout. O canal operante nesta etapa é WhatsApp.
