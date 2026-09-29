# Segurança e coleta responsável

## Autenticação e autorização

- Usuários usam e-mail e senha Argon2id; o seed exige senha inicial de pelo menos 16 caracteres.
- Sessão usa cookie HTTP-only, access de 15 minutos e refresh rotativo de até 30 dias.
- TOTP é exigido para a conta OWNER no primeiro login por padrão; os demais perfis podem ativar MFA no Manager. Uma conta com MFA habilitada sempre precisa informar o código no login. Recuperação por backup codes ainda não está nesta alpha.
- Membership define OWNER, ADMIN, OPERATOR e VIEWER por tenant. Tokens de API são por instância, guardados como hash SHA-256 e limitados por escopo; o segredo é mostrado uma única vez.
- Segredos TOTP pendentes e webhooks usam AES-256-GCM, com chave de 32 bytes mantida fora do banco.

## SSRF e browser

- Produção aceita apenas HTTPS. HTTP existe para desenvolvimento local.
- Cada fonte declara hostnames exatos. DNS, redirects e requests observados no browser são verificados; IPs privados, loopback, link-local e reservados são bloqueados.
- Timeout e tamanho de resposta são limitados; redirects são revalidados; robots.txt é respeitado por padrão; conteúdo binário não executa no HTTP Engine.
- Browser Worker fica separado da API, roda sem root, com capacidades e recursos reduzidos. A rede do host ainda precisa bloquear egress para ranges privados, metadata endpoints e redes internas.
- Colete apenas conteúdo para o qual você tenha autorização. Não contorne login, CAPTCHA, paywall, bloqueios, limites nem controles de acesso dos sites.

## Cookies e CORS

Mantenha `SCOUT_CORS_ORIGINS` restrito, `SCOUT_COOKIE_SECURE=true` com HTTPS e `SCOUT_TRUST_PROXY_HOPS` configurado com o número exato de proxies confiáveis. O proxy preserva `Origin`; a API rejeita mutações com origem não allowlisted.

## Retenção

Resultados vivem no PostgreSQL; screenshots no Garage/S3. Esta alpha não expira dados automaticamente. Defina retenção, backup cifrado e exclusão antes de habilitar coleta contínua.
