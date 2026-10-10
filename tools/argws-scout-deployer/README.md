# ARGWS Scout Deployer para Windows

O deployer portátil prepara uma instalação para Docker Compose, Dockge, CloudPanel ou Portainer, com armazenamento em `./volumes` e portas do Manager no intervalo 40000–49999. Ele gera credenciais aleatórias e grava somente `compose.yaml` e o arquivo de ambiente na pasta escolhida: `.env` para Docker, Dockge e CloudPanel, `stack.env` para Portainer. Não instala nem inicia serviços e não adiciona scripts aos pacotes de deploy.

## Pacote da release

Baixe `argws-scout-deployer-win-x64.zip` e extraia os dois executáveis juntos. A GUI chama o CLI que acompanha o pacote. Também é possível usar `argws-scout-deployer-win-x64.exe` diretamente em automações.

## Uso pelo terminal

```powershell
.\argws-scout-deployer-win-x64.exe list
.\argws-scout-deployer-win-x64.exe generate `
  --target dockge `
  --environment production `
  --output .\argws-scout-production `
  --public-url https://scout.seudominio.com.br `
  --manager-port 48181 `
  --browser-concurrency 1 `
  --tenant-name "Minha organização" `
  --tenant-slug minha-organizacao `
  --admin-name "Administrador" `
  --admin-email admin@seudominio.com.br
.\argws-scout-deployer-win-x64.exe validate --directory .\argws-scout-production
```

Para abrir a interface, execute `argws-scout-deployer-gui-win-x64.exe` depois de extrair o ZIP completo.

## Comportamento e proteção

- Produção exige URL HTTPS e usa a tag publicada `stable`; o canal develop usa a tag `develop`.
- As portas padrão do Manager ficam isoladas por alvo e canal na faixa `4xxxx` (40000–49999). CLI e GUI aceitam uma porta explícita **somente nessa faixa**.
- Cada instalação recebe chaves e senhas aleatórias. A senha do primeiro OWNER fica em `SCOUT_BOOTSTRAP_ADMIN_PASSWORD` no `.env`.
- Uma execução posterior preserva o `.env`. `--force` atualiza somente `compose.yaml`, sem modificar `./volumes`. O deployer aceita essa pasta em instalações já iniciadas.
- A GUI contém a aba **Recuperação de senha (SMTP)**, com host, porta, TLS, usuário, senha protegida, e-mail e nome do remetente. O SMTP é dedicado à recuperação de senha. A senha segue ao CLI por `stdin`, não por argumentos.
- A concorrência do navegador é configurável de 1 a 16 tarefas (padrão 1). Para alterar SMTP ou concorrência de um deploy **já existente**, edite o `.env`/`stack.env` atual: o gerador preserva as credenciais e não as substitui automaticamente.
- Dados persistentes usam diretórios relativos ao Compose: `./volumes/postgres`, `./volumes/redis`, `./volumes/rabbitmq` e `./volumes/garage/{config,meta,data}`. A mudança de volumes antigos exige migração previamente verificada (consulte `docs/deployment.md`).
- O Deployer 1.0.2 gera `GARAGE_RPC_SECRET` com 32 bytes aleatórios em hexadecimal (`secrets.token_hex(32)`). Versões anteriores geravam Base64 URL-safe, inválido para o Garage.
- A validação confirma as variáveis essenciais, a chave RPC de 64 caracteres hexadecimais, a chave de cifragem de 32 bytes e a presença apenas do Compose e do arquivo de ambiente esperado.
- Para uma pasta criada por versão anterior, corrija explicitamente `GARAGE_RPC_SECRET` no `.env`/`stack.env`; `--force` mantém as credenciais e não modifica automaticamente a chave. Preserve chaves válidas existentes.
- No Windows, mantenha a pasta gerada sob uma conta e um diretório com ACL restrita. O `.env` contém credenciais da instalação.

| Alvo       | Develop | Produção |
| ---------- | ------: | -------: |
| Docker     |    48080 |     48180 |
| Dockge     |    48081 |     48181 |
| CloudPanel |    48082 |     48182 |
| Portainer  |    48083 |     48183 |

## Parâmetros de SMTP via CLI

Ao gerar uma nova instalação, use `--recovery-smtp-host`, `--recovery-smtp-port`, `--recovery-smtp-secure`, `--recovery-smtp-username`, `--recovery-smtp-from-email`, `--recovery-smtp-from-name` e `--browser-concurrency`. Para autenticação SMTP, adicione `--recovery-smtp-password-stdin` e forneça a senha pela entrada padrão do processo (não pelo histórico do PowerShell nem por argumentos). Na interface gráfica, utilize o campo mascarado **Senha SMTP**. Os segredos não são incluídos nas mensagens de resultado.

A porta 587 normalmente usa STARTTLS (`false`); a 465 usa TLS direto (`true`). Host e remetente são exigidos juntos quando SMTP estiver habilitado.

## Desenvolvimento

Requer Python 3.12 para testar e empacotar; o computador que recebe os executáveis não precisa de Python.

```powershell
python -m unittest discover -s tools/argws-scout-deployer -p "test_*.py"
python -m pip install -r tools/argws-scout-deployer/requirements-build.txt
python -m PyInstaller --clean --onefile --name argws-scout-deployer-win-x64 `
  --add-data "deploy;deploy" --add-data "VERSION;." `
  tools/argws-scout-deployer/scout_deployer.py
python -m PyInstaller --clean --onefile --windowed --name argws-scout-deployer-gui-win-x64 `
  tools/argws-scout-deployer/deployer_gui.py
```
