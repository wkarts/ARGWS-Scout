# Fluxo de desenvolvimento e release

## Repositórios e branches

- main: linha de release estável.
- develop: integração e teste no ambiente de staging.
- feat/_, fix/_, docs/_, test/_ e chore/*: branches curtas, abertas para develop.
- A promoção para main é feita somente por PR revisada develop → main. Um PR direto de branch curta para main é recusado pelo quality gate.
- O arquivo VERSION e todos os manifests workspace são alterados na mesma mudança. develop usa SemVer pre-release; main usa SemVer estável.

## Quality gates

O workflow Quality gates roda para PRs e pushes em develop/main. Ele instala dependências com lockfile congelado, aplica migrations em PostgreSQL limpo, executa seed, typecheck, testes, build e verificação Prettier. Também valida os oito arquivos Compose e prova que só Manager publica uma porta em 127.0.0.1, enquanto os dados usam cinco bind mounts relativos.

O workflow Security executa CodeQL e revisão de dependências em PR. O teste de segurança de rede/egress do browser worker precisa ser realizado no ambiente hospedado da implantação.

## Distribuição

1. O workflow GHCR infrastructure images espelha tags versionadas de PostgreSQL, Redis, RabbitMQ, Garage, Alpine, Node, Nginx e Playwright. Execute-o manualmente na primeira configuração; a rotina semanal republica as mesmas versões fixadas e mudanças de versão entram por revisão.
2. Um push em develop publica runtime, Manager, docs, browser-worker e garage-init com tag develop após os quality gates.
3. O PR develop → main deve atualizar VERSION para SemVer estável.
4. Após push aprovado em main, as cinco imagens recebem a versão e stable.
5. Somente após a publicação das imagens o workflow SemVer cria v<version> e GitHub Release.

Não existe tag móvel latest. O deploy de produção pode usar stable ou uma versão fixa SemVer. Para rollback, fixe cada imagem funcional na versão anterior, implante e valide API, jobs, webhooks e acesso aos artefatos.

## Configuração do repositório GitHub

- Ative proteção de main e develop: PR obrigatório, checks concluídos e revisão.
- Configure permissões Actions para publicar pacotes do GitHub Container Registry.
- Execute a sincronização inicial GHCR antes do primeiro build de aplicação, pois as etapas build usam Node/Nginx/Playwright espelhados.
- Após a primeira sincronização, publique os pacotes GHCR como públicos se os hosts de produção precisarem fazer pull anônimo.
- Considere configurar CODEOWNERS, regras de retenção e ambiente de release com aprovadores do time.
- O owner `wkarts` aparece nas variáveis de imagem de exemplo; ajuste cada referência se o repositório for transferido ou bifurcado.

O repositório wkarts/ARGWS-Scout e sua branch remota não foram criados por este pacote. Estes arquivos deixam o projeto pronto para revisão e criação no GitHub.
