# ARGWS Scout v0.8.1 — Fotografias oficiais no refinamento

A v0.8.1 atualiza o processamento opcional de conteúdo da v0.8.0 para priorizar fotografias verificáveis, sem modificar o retorno das coletas, as instâncias e as revisões anteriores.

## Correções e melhorias

- **Coleta:** identifica fotos em `img`, `picture`, `srcset` e lazy loading, inclusive cartões com imagem e texto em links distintos.
- **Metadados:** interpreta imagens de JSON-LD e `ImageObject`; tenta recuperar a fotografia na página oficial quando a coleta não contém foto ou o download falha.
- **Cobertura:** o limite de páginas de enriquecimento acompanha o lote configurado, evitando parar nos primeiros dez itens.
- **Armazenamento:** fotografias recuperadas são salvas separadamente como `original.webp` privado no Garage/S3.
- **Prévia:** o Manager exibe e amplia a foto original, permite compará-la à arte de publicação e mostra links HTTPS públicos como prévias online quando o download falha.
- **Histórico:** **Atualizar fotografias oficiais** cria um lote novo a partir da captura original e preserva os lotes anteriores, suas mídias e decisões de aprovação.
- **Compatibilidade:** versões da API, Manager, workers, pacotes, exemplos de implantação e deployer Windows sincronizadas.

## Implantação segura

Faça backup do PostgreSQL, Garage/S3, volumes e `.env`. Preserve o `COMPOSE_PROJECT_NAME`, os segredos, as portas e as configurações atuais. Não execute `docker compose down -v`.

As imagens `ghcr.io/wkarts/argws-scout-*:0.8.1` são publicadas pelo pipeline após a promoção `develop` → `main`, juntamente com `stable` e `latest`. A publicação não atualiza automaticamente os serviços Docker, Dockge, CloudPanel ou Portainer.

Se utiliza refinamento, preserve `SCOUT_CONTENT_ENABLED=true`, `COMPOSE_PROFILES=content` e `SCOUT_CONTENT_ENGINE_KEY`; não é necessário ativar o módulo em instalações que não o usam. Após atualização, confira a versão da aplicação, login/MFA, migrações, artefatos privados, prévias e revisão de itens.

## Limites

Imagens online podem não carregar devido a hotlink, controle de acesso ou políticas do site. Quando a fotografia oficial não estiver disponível, a arte ilustrativa continuará identificada. A aplicação não inventa nem atribui imagens de outros produtos ao anúncio.

Consulte [Refinamento e publicações](content-refinement.md), [Implantação](deployment.md) e [PR #44](https://github.com/wkarts/ARGWS-Scout/pull/44).
