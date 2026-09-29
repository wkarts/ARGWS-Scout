# Contribuição

1. Trabalhe em `feat/*`, `fix/*`, `docs/*`, `test/*` ou `chore/*`.
2. Abra PR para `develop`; não desenvolva diretamente em `main`.
3. Mantenha API, browser worker e Manager desacoplados por contratos versionados.
4. Não adicione dependência, código, identidade visual ou serviço interno da Connect API.
5. Rode `pnpm typecheck`, `pnpm test`, `pnpm build` e `pnpm format:check` antes de solicitar revisão.
6. Novos collectors devem validar allowlist, SSRF, timeout, limite de bytes, robots/políticas aplicáveis e sanitização de dados.
7. Não registre tokens, cookies, senhas, segredos de webhook, conteúdo privado ou corpos completos de páginas.

Commits seguem Conventional Commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:`). A branch `develop` publica apenas imagens `:develop`; apenas a promoção aprovada para `main` publica SemVer e `:latest`.
