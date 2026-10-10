# Deploy ARGWS Scout

Cada pacote em `deploy/{docker,dockge,cloudpanel,portainer}/{develop,production}` contém apenas `compose.yaml` e `.env.example`. Os manifests não fazem build no host nem pedem scripts, arquivos de configuração ou serviços externos. Aplicação e dependências de infraestrutura são baixadas do GHCR.

## Perfil por plataforma

| Plataforma           | Persistência                                                 | Ambiente               | Porta padrão (develop / production) |
| -------------------- | ------------------------------------------------------------ | ---------------------- | ----------------------------------- |
| Docker Compose       | `./volumes` ao lado do Compose                               | `.env`                 | `48080 / 48180`                     |
| Dockge               | `./volumes` dentro da pasta da stack                         | `.env`                 | `48081 / 48181`                     |
| CloudPanel           | `./volumes` na pasta da stack                                | `.env` e proxy reverso | `48082 / 48182`                     |
| Portainer Standalone | `./volumes` relativo ao diretório efetivo do Compose no host | `stack.env`            | `48083 / 48183`                     |

Todos os dados persistentes ficam em bind mounts locais: `./volumes/postgres`, `./volumes/redis`, `./volumes/rabbitmq`, `./volumes/garage/config`, `./volumes/garage/meta` e `./volumes/garage/data`. Não existem volumes nomeados nos novos manifests. Diretórios não existentes são criados pelo Docker ao iniciar os serviços.

Mantenha `COMPOSE_PROJECT_NAME` inalterado. Todas as portas **externas do Manager** têm cinco dígitos e começam com 4 (40000–49999). Isso não altera as portas internas dos serviços, como 8080 na API. Para atualizar uma instalação existente, ajuste o valor de `SCOUT_MANAGER_PORT` no ambiente e também a configuração do proxy reverso.

**Portainer:** bind mounts relativos só funcionam de modo previsível quando o diretório efetivo da stack está disponível no host de execução. Instalações feitas diretamente pelo editor web podem utilizar um diretório gerenciado pelo Portainer, diferente daquele pretendido. Verifique o caminho de origem real com `docker inspect` antes de gravar dados. Para controle pleno, use uma pasta estável no host e faça deploy com Docker Compose/Dockge. Docker Swarm não é suportado pelos manifests Standalone.

No Dockge, alterar somente `SCOUT_TAG` não atualiza o Compose salvo pela interface. Substitua também a definição YAML preservando projeto, ambiente e diretórios persistentes.

### Migração de volumes nomeados existentes

**Não aponte uma instalação já usada para bind mounts vazios.** Faça backup verificado, pare os serviços e copie o conteúdo para o novo local antes de aplicar o Compose atualizado. Uma migração sem cópia pode fazer o banco parecer vazio, embora os dados ainda estejam no volume antigo.

As versões anteriores de Docker/Dockge/CloudPanel já armazenavam PostgreSQL, Redis, RabbitMQ e Garage meta/data em `./volumes`, mas a configuração do Garage estava no volume `<COMPOSE_PROJECT_NAME>-garage-config`. Migre o volume para `./volumes/garage/config`. No Portainer anterior, todos os seis volumes precisam ser migrados.

Exemplo para a VPS, com stack parada e backup concluído:

```bash
# Execute na pasta da stack antiga antes de substituir o Compose.
export PROJECT=argws-scout-dockge-production # ajuste para seu COMPOSE_PROJECT_NAME
docker compose stop
mkdir -p ./volumes/garage/config
source_dir="$(docker volume inspect -f '{{ .Mountpoint }}' "$PROJECT-garage-config")" || exit 1
test -d "$source_dir" || exit 1
test -z "$(ls -A ./volumes/garage/config)" || { echo "Destino não vazio"; exit 1; }
cp -a "$source_dir/." ./volumes/garage/config/
test -s ./volumes/garage/config/garage.toml
```

Para Portainer, depois de parar a stack antiga e preparar a pasta definitiva no **host**, copie também os volumes de dados:

```bash
export PROJECT=argws-scout-portainer-production # ajuste para sua instalação
while read -r suffix relative; do
  src="$(docker volume inspect -f '{{ .Mountpoint }}' "$PROJECT-$suffix")" || exit 1
  dest="./volumes/$relative"
  mkdir -p "$dest"
  test -z "$(ls -A "$dest")" || { echo "Destino não vazio: $dest"; exit 1; }
  cp -a "$src/." "$dest/" || exit 1
done <<'EOF'
postgres postgres
redis redis
rabbitmq rabbitmq
garage-config garage/config
garage-meta garage/meta
garage-data garage/data
EOF
```

A cópia física do PostgreSQL exige que o banco esteja parado. Não remova os volumes antigos antes da conferência da restauração, do acesso aos arquivos e de um novo backup consistente. Preserve permissões, UID/GID, chaves RPC e credenciais.

### Status no Dockge

A marcação `encerrado` é atribuída pelo Dockge ao estado detectado da stack; não há uma propriedade no YAML que permita forçar a cor azul. Os serviços `garage-config-init`, `garage-init`, `migrate` e `bootstrap` são tarefas temporárias que devem terminar com código 0. Mantê-los artificialmente em execução apenas para mudar a cor mascara problemas reais.

```bash
docker compose config --quiet
docker compose up -d
docker compose ps -a
docker compose logs --tail=100 api manager garage-config-init garage-init migrate bootstrap
```

Verifique por que a stack está indicada como encerrada, especialmente quando `api`, `manager` e as dependências persistentes não permanecem em execução. Tarefas `exited (0)` são esperadas; serviços persistentes parados ou `unhealthy` não são.

**Problema conhecido do Dockge:** a interface pode mostrar a stack inteira como `encerrado` só porque uma tarefa temporária terminou normalmente, mesmo quando todos os serviços permanentes estão ativos ([issue #806](https://github.com/louislam/dockge/issues/806), também observado na [issue #11](https://github.com/louislam/dockge/issues/11)). Quando **todos os quatro inicializadores tiverem concluído com exit 0** e os serviços principais estiverem `Up/healthy`, é possível remover **somente os contêineres temporários já concluídos** para que deixem de influenciar a agregação do estado:

```bash
docker compose ps -a
# Execute SOMENTE se os quatro serviços estiverem Exited (0).
docker compose rm -f garage-config-init garage-init migrate bootstrap
docker compose ls --all
docker compose ps -a
```

Essa remoção é **somente dos contêineres temporários**, não dos volumes ou bind mounts; os dados persistentes permanecem. Ao executar `docker compose up -d` novamente, as tarefas temporárias podem ser recriadas e a indicação vermelha voltar. A correção definitiva da apresentação do status depende do Dockge, não de uma configuração de cor do Scout. **Não execute a limpeza se alguma tarefa terminou com erro**, pois isso ocultaria a falha que precisa ser diagnosticada.

## Instalação e atualização

Para Docker Compose, Dockge e CloudPanel, coloque os dois arquivos na mesma pasta, copie `.env.example` para `.env`, gere e preencha cada segredo, ajuste `SCOUT_PUBLIC_URL` e mantenha `COMPOSE_PROJECT_NAME`. Para atualização pelo terminal, execute `docker compose pull` e `docker compose up -d`; isso aplica o novo `SCOUT_TAG` sem recriar os volumes. O serviço `bootstrap` executa automaticamente após as migrações e **antes da API**, criando o primeiro OWNER somente quando o banco estiver vazio. Instalações já povoadas não recebem novos usuários, alterações de senha ou elevação de permissões.

Na CloudPanel, configure o domínio HTTPS para encaminhar ao `127.0.0.1` na porta indicada pelo `SCOUT_MANAGER_PORT`. Nenhum container de proxy adicional é necessário. O acesso público às imagens GHCR exige pacotes com leitura pública; se os pacotes forem privados, autentique o host no GHCR antes de baixar.

Os `.env.example` trazem marcadores, não segredos prontos para produção. Use uma chave Base64 aleatória de 32 bytes em `SCOUT_ENCRYPTION_KEY_BASE64`; a API agora valida essa chave durante a inicialização para evitar que o Manager abra e falhe apenas ao salvar credenciais da Connect API.

As dez imagens da Scout usam `SCOUT_IMAGE_OWNER` e `SCOUT_TAG`; os serviços de base (PostgreSQL, Redis, RabbitMQ e Garage) mantêm tags próprias e fixas. Para atualizar uma produção, troque somente `SCOUT_TAG` pela versão publicada e use pull/redeploy. `develop` acompanha a tag móvel `develop`. O Compose pede pull em cada atualização. Faça backup do banco e do Garage antes de trocar a versão, depois valide API, Manager, coleta e envio WhatsApp.

## Bases, publicação e cache

O workflow sincroniza bases PostgreSQL, Redis, RabbitMQ, Garage, Alpine, Node, Nginx, Playwright e BuildKit para GHCR antes de compilar a aplicação. Mantém tags de base fixadas e só as atualiza por revisão ou refresh manual. Uma PR revisada de `develop` para `main` publica imagens SemVer após os quality gates; a release do Git é criada depois que as imagens terminam de publicar.

O BuildKit mantém cache por componente. Após uma publicação validada, a política remove somente caches próprios sem acesso há duas horas; não remove tags ou imagens de release.

Não execute `docker compose down --volumes` para atualizar ou reverter: isso remove os dados persistentes. Use `pull` e `up -d`; o nome `COMPOSE_PROJECT_NAME` identifica as redes e volumes que devem sobreviver à atualização.

## Login 401 e bootstrap seguro

Em uma instalação recém-criada, confira `SCOUT_BOOTSTRAP_ADMIN_EMAIL` e `SCOUT_BOOTSTRAP_ADMIN_PASSWORD` (16 a 256 caracteres) antes de executar `docker compose up -d`. O serviço `bootstrap` roda automaticamente após `migrate` e a API aguarda sua conclusão. Se já existir **qualquer** usuário, o bootstrap é não destrutivo: não cria contas nem reatribui OWNER e não altera senha, MFA ou configuração do tenant. A senha que está no `.env` pode não ser a senha persistida se tiver sido trocada anteriormente.

Para inspecionar sem revelar senhas, hashes ou segredos, na pasta da stack:

```bash
docker compose exec -T api pnpm auth:diagnose
# Para comparar com segurança a senha inicial do .env, use o serviço isolado:
docker compose run --rm -T --no-deps bootstrap pnpm auth:diagnose
docker compose logs --tail=60 bootstrap
```

O relatório indica `bootstrapAccountFound`, `bootstrapPasswordMatchesStoredHash` e as organizações do OWNER. No contêiner persistente da API a comparação da senha retorna `null` intencionalmente, pois a senha inicial fica restrita ao `bootstrap`. A comparação só deve ser executada no contêiner temporário de diagnóstico. O `GET /auth/me` devolver 401 antes do login é esperado; `POST /auth/login` com 401 indica credenciais incorretas, usuário desativado ou inexistente.

Se houver usuário existente e você tiver controle legítimo da VPS, prefira `Esqueci minha senha` com o SMTP de recuperação corretamente configurado. Sem SMTP, é possível recuperar **somente uma conta OWNER ativa** a partir do terminal interativo do contêiner:

```bash
docker compose exec api pnpm auth:recover-owner
```

O operador deve confirmar digitando `REDEFINIR` e fornecer uma nova senha duas vezes; a entrada fica oculta, nenhuma senha vai para argumentos de processo, variáveis de contêiner ou logs. O procedimento revoga sessões existentes, invalida tokens de redefinição e preserva MFA e permissões. Caso o OWNER tenha perdido o autenticador, a recuperação de senha não remove a exigência do MFA.

Não execute `docker compose down -v`, não troque `COMPOSE_PROJECT_NAME`, não altere os volumes e não use `pnpm db:seed` para redefinir uma senha já existente. Se o e-mail de OWNER armazenado no banco for diferente do `.env`, o operador poderá selecionar explicitamente outro OWNER configurando somente `SCOUT_AUTH_RECOVERY_EMAIL` para **essa execução**, sem nenhuma senha nessa variável.

## SMTP global e concorrência do navegador

O SMTP global atende **exclusivamente à recuperação de senha pela API**. Os outros serviços continuam sem essas credenciais. O deployer Windows tem aba exclusiva e envia a senha ao CLI pela entrada padrão, sem colocá-la nos argumentos do processo. Se SMTP for configurado, host e remetente são obrigatórios; usuário e senha devem ser fornecidos juntos quando a autenticação for necessária.

```dotenv
SCOUT_RECOVERY_SMTP_HOST=
SCOUT_RECOVERY_SMTP_PORT=587
SCOUT_RECOVERY_SMTP_SECURE=false
SCOUT_RECOVERY_SMTP_USERNAME=
SCOUT_RECOVERY_SMTP_PASSWORD=
SCOUT_RECOVERY_SMTP_FROM_EMAIL=
SCOUT_RECOVERY_SMTP_FROM_NAME=ARGWS Scout
SCOUT_BROWSER_CONCURRENCY=1
```

A porta 587 normalmente usa STARTTLS (`SCOUT_RECOVERY_SMTP_SECURE=false`); a porta 465 costuma usar TLS direto (`true`). O deployer não sobrescreve arquivos de ambiente existentes: para atualizar uma instalação, edite o `.env`/`stack.env` após fazer backup e recrie somente `api` para aplicar o SMTP ou `browser-worker` para aplicar a concorrência.

## Chromium no browser-worker

O Chromium, ao executar `chromiumSandbox: true`, exige suporte a namespaces e permissões que alguns hosts Ubuntu/Docker bloqueiam com AppArmor/seccomp. Nesses casos surge `No usable sandbox` e o processo reinicia continuamente. A configuração agora é explícita em `SCOUT_BROWSER_CHROMIUM_SANDBOX`: `true` habilita o sandbox nativo; `false` usa o isolamento do contêiner, necessário na configuração padrão das distribuições Docker restritivas.

```dotenv
SCOUT_BROWSER_CHROMIUM_SANDBOX=false
```

**Atenção:** desativar o sandbox interno do Chromium reduz a defesa em profundidade ao processar sites não confiáveis. Por isso, o browser-worker permanece como usuário não root, com `no-new-privileges`, `cap_drop: [ALL]`, limites de CPU/RAM e diretório temporário isolado. O administrador **deve aplicar política de egress no host** para impedir acesso a redes privadas, à API de metadados da nuvem e aos demais serviços internos. A validação SSRF da aplicação não é equivalente ao bloqueio de rede do host. Se o host suportar sandbox do Chromium, use `SCOUT_BROWSER_CHROMIUM_SANDBOX=true`.

## Garage: chave RPC válida e recuperação sem perda de dados

O Garage exige `GARAGE_RPC_SECRET` com **64 caracteres hexadecimais**, equivalentes a 32 bytes aleatórios. Gere uma vez com `openssl rand -hex 32`, grave no `.env` (ou `stack.env`/variáveis do Portainer) e **não altere uma chave válida nas atualizações**. Não use `replace-me`, Base64, `secrets.token_urlsafe()` ou um valor com menos de 64 caracteres.

O Deployer Windows até a versão 1.0.0 gerava a chave RPC em Base64 URL-safe, formato rejeitado pelo Garage 2.4.1. A partir do Deployer 1.0.1, a chave é criada usando `secrets.token_hex(32)`, e a validação da pasta de deploy recusa formatos incorretos. O gerador preserva o arquivo de ambiente já existente ao atualizar o Compose: uma instalação afetada precisa corrigir explicitamente seu segredo persistente.

Para recuperar uma instalação em Docker Compose, Dockge ou CloudPanel **cujo Garage nunca iniciou com a chave atual**, execute na pasta que contém o Compose e o `.env`:

```bash
set -e
umask 077
cp -p .env ".env.backup.$(date +%Y%m%d-%H%M%S)"
python3 - <<'PY'
from pathlib import Path
import re, secrets
env_file = Path('.env')
content = env_file.read_text(encoding='utf-8')
lines = content.splitlines(keepends=True)
matches = [i for i, line in enumerate(lines) if re.match(r'^GARAGE_RPC_SECRET=', line)]
if len(matches) != 1:
    raise SystemExit('Esperado exatamente um GARAGE_RPC_SECRET no .env; corrija manualmente.')
index = matches[0]
raw_value = lines[index].split('=', 1)[1].strip().strip('"').strip("'")
if re.fullmatch(r'[0-9a-fA-F]{64}', raw_value):
    print('Chave RPC já válida; nenhuma alteração realizada.')
else:
    newline = '\r\n' if lines[index].endswith('\r\n') else '\n'
    lines[index] = 'GARAGE_RPC_SECRET=' + secrets.token_hex(32) + newline
    env_file.write_text(''.join(lines), encoding='utf-8')
    env_file.chmod(0o600)
    print('Chave RPC corrigida e gravada no .env, sem exibi-la.')
PY
docker compose config --quiet
docker compose up -d garage-config-init garage garage-init
docker compose up -d
docker compose ps
docker compose logs --tail=80 garage-config-init garage garage-init
```

Se essa instância já funcionou anteriormente com outra chave RPC válida, **não gere uma chave nova**: recupere a chave original do backup do ambiente para manter a identidade criptográfica do nó. Em Portainer, atualize a variável `GARAGE_RPC_SECRET` na interface e faça redeploy preservando os volumes; o roteiro acima é destinado a `.env` local. No Dockge, confira também se a variável definida na interface sobrescreve o `.env` da pasta.

O `garage-config-init` agora verifica tamanho e caracteres da chave **antes** de tocar em `garage.toml`. Um valor inválido encerra o inicializador com mensagem clara, sem criar/substituir configurações e sem iniciar o loop de reinicialização do Garage. `COMPOSE_PROJECT_NAME`, volumes, chaves S3 e credenciais do PostgreSQL/Redis/RabbitMQ permanecem inalterados.

## Garage: correção do bootstrap S3

Nas oito distribuições, `garage-config-init` grava `garage.toml` no diretório `./volumes/garage/config`, montado em `/etc/garage-config` no Garage. Ambos os scripts `garage-config-init` e `garage-init` precisam receber o script inteiro como **um único argumento** de `/bin/sh -ec`. Use `command:` como lista com um elemento de texto multilinha (`- |`); `command: |` e `command: >-` escalares não preservam corretamente o script ao gerar o comando de execução do container.

A inicialização verifica `test -s /config/garage.toml`. Se o arquivo já existir e contiver dados, é preservado. Dados e metadados S3 permanecem nos seus volumes originais.
O inicializador `garage-init` monta o mesmo diretório persistente `garage/meta` do servidor **em somente leitura** (`:ro`). O cliente CLI precisa ler nesse diretório a chave do nó para operar, mesmo quando compartilha a rede do container `garage`.

**Recuperação de Dockge em produção:** substitua a definição do Compose pelo conteúdo corrigido de `deploy/dockge/production/compose.yaml`, mantendo intactos `COMPOSE_PROJECT_NAME`, `.env`, credenciais, bind mounts e volumes. Alterar apenas `SCOUT_TAG` não atualiza o YAML da stack já cadastrada no Dockge. Dentro do diretório da stack:

```bash
docker compose config --quiet
docker compose pull
docker compose up -d --force-recreate garage-config-init garage garage-init
docker compose up -d
docker compose ps -a
docker compose logs --tail=80 garage-config-init garage garage-init
```

**Não execute** `docker compose down -v`, `docker volume prune` ou exclusão de `./volumes`: isso pode destruir os dados. Se ainda houver erro, os logs de `garage` e `garage-init` devem indicar possíveis problemas independentes de credenciais, permissões ou estado do armazenamento.

## RabbitMQ: readiness leve em todos os deploys

O Scout utiliza o RabbitMQ exclusivamente pela rede interna `rabbitmq:5672` para API, dispatcher e workers. Todos os manifests (`compose.yaml`, `ops/deployment/compose.yaml` e os oito bundles em `deploy/`) devem usar a mesma checagem TCP local e **não** executar `rabbitmq-diagnostics ping` a cada poucos segundos. A CLI inicia sessões Erlang adicionais e, quando muitas stacks compartilham a VPS, pode causar consumo desnecessário de CPU.

```yaml
healthcheck:
  test: ["CMD", "bash", "-ec", "exec 3<>/dev/tcp/127.0.0.1/5672"]
  interval: 60s
  timeout: 5s
  retries: 5
  start_period: 90s
```

A imagem padrão `rabbitmq:4.3.6-management-alpine` (espelhada como `ghcr.io/wkarts/argws-scout-rabbitmq`) possui Bash em seu entrypoint. A checagem usa apenas o próprio Bash, sem `nc`, `curl` ou comandos Erlang. **Se a imagem for substituída**, a disponibilidade do Bash e o acesso a `/dev/tcp` devem ser confirmados antes de implantar. O teste apenas confirma a abertura da porta AMQP local: não valida autenticação, filas, alarmes, recuperação de consumidores ou conectividade externa.

Antes de iniciar a primeira stack ou recriar um broker existente, valide:

```bash
docker compose --env-file .env -f compose.yaml config --quiet
docker compose --env-file .env -f compose.yaml config --format json > /tmp/scout-compose.json
# Opcional, após o RabbitMQ existir: confira se o healthcheck está healthy.
docker compose ps rabbitmq
```

A atualização de um serviço RabbitMQ **já iniciado** pode exigir recriação e interromper conexões momentaneamente. Não use `docker compose down -v`, não remova dados, não troque nomes de projeto/volumes e não altere credenciais. Preserve consumidores e acompanhe o backlog da fila antes e depois. O healthcheck Docker não é um mecanismo automático de correção de indisponibilidade do broker. Se for necessário monitoramento aprofundado, use métricas do plugin Prometheus/RabbitMQ em frequência separada e adequada.

Os contratos automatizados em `test/deployment-contract.py` e `scripts/validate-compose-model.py` impedem regressão para o check CLI pesado e conferem a verificação TCP nos arquivos de origem e no modelo renderizado.

## Correção de montagem tmpfs do navegador — v0.5.1

O `browser-worker` utiliza `tmpfs` em `/tmp` com `rw,noexec,nosuid,size=512m` para isolamento do navegador. **As opções devem estar em um único item**, não em quatro itens do YAML:

```yaml
# Correto: um mount com destino absoluto e opções
tmpfs: ["/tmp:rw,noexec,nosuid,size=512m"]

# Incorreto: o Docker interpreta "noexec" como novo destino de montagem
# tmpfs: [/tmp:rw, noexec, nosuid, size=512m]
```

O formato incorreto impede a criação do serviço e pode interromper o deploy com `Error response from daemon: invalid mount path: 'noexec' mount path must be absolute`. A versão 0.5.1 corrige os oito bundles de plataforma e o manifesto `ops/deployment/compose.yaml`; o Compose de desenvolvimento principal já continha a forma correta.

Execute `docker compose --env-file .env -f compose.yaml config --format json` e confirme que `services.browser-worker.tmpfs` tem um único item antes de iniciar o stack. O contrato em `scripts/validate-compose-model.py` valida também destinos absolutos para todos os volumes.

Para recuperar o Dockge Production, **atualize a definição Compose do stack** com o arquivo da versão corrigida. Não basta trocar o tag da imagem: essa falha está na configuração de montagem, não no código da imagem. Após conferir `config --quiet`, recrie apenas o serviço afetado quando possível; serviços que dependem de migrations/bootstraps devem respeitar a ordem de inicialização. Não execute `docker compose down -v`, não altere `COMPOSE_PROJECT_NAME` e mantenha os volumes existentes.
