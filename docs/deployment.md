# Deploy ARGWS Scout

Cada pacote em `deploy/{docker,dockge,cloudpanel,portainer}/{develop,production}` contém apenas `compose.yaml` e `.env.example`. Os manifests não fazem build no host nem pedem scripts, arquivos de configuração ou serviços externos. Aplicação e dependências de infraestrutura são baixadas do GHCR.

## Perfil por plataforma

| Plataforma     | Persistência                                               | Entrada de variáveis                                                                          | Porta padrão do Manager           |
| -------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------- | --------------------------------- |
| Docker Compose | Diretórios `./volumes` ao lado do Compose                  | Copie `.env.example` para `.env`                                                              | develop `8080`, production `8180` |
| Dockge         | Diretórios `./volumes` dentro da pasta gerenciada do stack | Mantenha `.env` ao lado do Compose                                                            | develop `8081`, production `8181` |
| CloudPanel     | Diretórios `./volumes` da stack                            | `.env` ao lado do Compose; proxy CloudPanel para `127.0.0.1`                                  | develop `8082`, production `8182` |
| Portainer      | Volumes Docker com nome do projeto                         | Docker Standalone: carregue `.env.example` como variáveis do stack; o Compose usa `stack.env` | develop `8083`, production `8183` |

Cada arquivo tem `COMPOSE_PROJECT_NAME` próprio por plataforma e ambiente. Preserve esse valor ao atualizar: ele identifica rede e volumes e evita colisão entre staging e produção. Docker, Dockge e CloudPanel mantêm os dados nos diretórios relativos da stack; Portainer usa volumes nomeados. As portas de loopback também são isoladas para permitir que vários stacks compartilhem o mesmo host.

No Dockge, use a ação de atualização da stack para baixar imagens e recriar os serviços depois de alterar `SCOUT_TAG`; o diretório `./volumes` permanece associado à pasta da stack. Na CloudPanel, atualize a mesma stack com `docker compose pull` e `docker compose up -d` após trocar `SCOUT_TAG`.

Em instalações Portainer existentes da 0.3.0, pare a stack e faça backup antes da atualização: os novos volumes nomeados não reaproveitam automaticamente os bind mounts antigos em `./volumes`. Copie ou restaure PostgreSQL, Redis, RabbitMQ e Garage nos volumes `${COMPOSE_PROJECT_NAME}-postgres`, `-redis`, `-rabbitmq`, `-garage-meta` e `-garage-data` antes do primeiro deploy; mantenha `COMPOSE_PROJECT_NAME` estável.

O bundle de Portainer é para endpoint **Docker Standalone**. Docker Swarm tem outra semântica de stack, variáveis e volumes e não é suportado por estes manifests. No Portainer, dê ao stack o mesmo nome definido em `COMPOSE_PROJECT_NAME` e importe o `.env.example` na seção de variáveis do stack. O manifest passa essas variáveis aos containers por `stack.env`, que o Portainer fornece no modo Docker Standalone. Para atualizar, edite `SCOUT_TAG`, faça pull das imagens e redeploy do stack.

## Instalação e atualização

Para Docker Compose, Dockge e CloudPanel, coloque os dois arquivos na mesma pasta, copie `.env.example` para `.env`, gere e preencha cada segredo, ajuste `SCOUT_PUBLIC_URL` e mantenha `COMPOSE_PROJECT_NAME`. Para atualização pelo terminal, execute `docker compose pull` e `docker compose up -d`; isso aplica o novo `SCOUT_TAG` sem recriar os volumes. O OWNER inicial é criado uma vez com `docker compose --profile maintenance run --rm bootstrap`.

Na CloudPanel, configure o domínio HTTPS para encaminhar ao `127.0.0.1` na porta indicada pelo `SCOUT_MANAGER_PORT`. Nenhum container de proxy adicional é necessário. O acesso público às imagens GHCR exige pacotes com leitura pública; se os pacotes forem privados, autentique o host no GHCR antes de baixar.

Os `.env.example` trazem marcadores, não segredos prontos para produção. Use uma chave Base64 aleatória de 32 bytes em `SCOUT_ENCRYPTION_KEY_BASE64`; a API agora valida essa chave durante a inicialização para evitar que o Manager abra e falhe apenas ao salvar credenciais da Connect API.

As dez imagens da Scout usam `SCOUT_IMAGE_OWNER` e `SCOUT_TAG`; os serviços de base (PostgreSQL, Redis, RabbitMQ e Garage) mantêm tags próprias e fixas. Para atualizar uma produção, troque somente `SCOUT_TAG` pela versão publicada e use pull/redeploy. `develop` acompanha a tag móvel `develop`. O Compose pede pull em cada atualização. Faça backup do banco e do Garage antes de trocar a versão, depois valide API, Manager, coleta e envio WhatsApp.

## Bases, publicação e cache

O workflow sincroniza bases PostgreSQL, Redis, RabbitMQ, Garage, Alpine, Node, Nginx, Playwright e BuildKit para GHCR antes de compilar a aplicação. Mantém tags de base fixadas e só as atualiza por revisão ou refresh manual. Uma PR revisada de `develop` para `main` publica imagens SemVer após os quality gates; a release do Git é criada depois que as imagens terminam de publicar.

O BuildKit mantém cache por componente. Após uma publicação validada, a política remove somente caches próprios sem acesso há duas horas; não remove tags ou imagens de release.

Não execute `docker compose down --volumes` para atualizar ou reverter: isso remove os dados persistentes. Use `pull` e `up -d`; o nome `COMPOSE_PROJECT_NAME` identifica as redes e volumes que devem sobreviver à atualização.

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

Nas oito distribuições, `garage-config-init` grava `garage.toml` no volume `garage-config-data`, montado em `/etc/garage-config` no Garage. Ambos os scripts `garage-config-init` e `garage-init` precisam receber o script inteiro como **um único argumento** de `/bin/sh -ec`. Use `command:` como lista com um elemento de texto multilinha (`- |`); `command: |` e `command: >-` escalares não preservam corretamente o script ao gerar o comando de execução do container.

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
