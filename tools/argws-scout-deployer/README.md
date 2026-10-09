# ARGWS Scout Deployer para Windows

O deployer portátil prepara uma instalação para Docker Compose, Dockge, CloudPanel ou Portainer. Ele gera credenciais aleatórias e grava somente `compose.yaml` e o arquivo de ambiente na pasta escolhida: `.env` para Docker, Dockge e CloudPanel, `stack.env` para Portainer. Não instala nem inicia serviços e não adiciona scripts aos pacotes de deploy.

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
  --manager-port 8181 `
  --tenant-name "Minha organização" `
  --tenant-slug minha-organizacao `
  --admin-name "Administrador" `
  --admin-email admin@seudominio.com.br
.\argws-scout-deployer-win-x64.exe validate --directory .\argws-scout-production
```

Para abrir a interface, execute `argws-scout-deployer-gui-win-x64.exe` depois de extrair o ZIP completo.

## Comportamento e proteção

- Produção exige URL HTTPS e usa a tag publicada `stable`; o canal develop usa a tag `develop`.
- As portas padrão do Manager ficam isoladas por alvo e canal; CLI e GUI aceitam uma porta explícita para substituí-las.
- Cada instalação recebe chaves e senhas aleatórias. A senha do primeiro OWNER fica em `SCOUT_BOOTSTRAP_ADMIN_PASSWORD` no `.env`.
- Uma execução posterior preserva o `.env`. `--force` atualiza somente `compose.yaml`.
- A validação confirma as variáveis essenciais, a chave de cifragem de 32 bytes e a presença apenas do Compose e do arquivo de ambiente esperado.
- No Windows, mantenha a pasta gerada sob uma conta e um diretório com ACL restrita. O `.env` contém credenciais da instalação.

| Alvo       | Develop | Produção |
| ---------- | ------: | -------: |
| Docker     |    8080 |     8180 |
| Dockge     |    8081 |     8181 |
| CloudPanel |    8082 |     8182 |
| Portainer  |    8083 |     8183 |

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
