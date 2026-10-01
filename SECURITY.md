# Segurança

Reporte vulnerabilidades privadamente ao mantenedor do repositório. Não abra issue pública com detalhes exploráveis ou credenciais.

## Baseline

- Senhas Argon2id; sessões curtas com refresh rotativo e cookies HTTP-only para o Manager.
- TOTP para autenticação de dois fatores; MFA obrigatório para OWNER por padrão.
- Tokens de API guardados como hash e apresentados integralmente uma única vez.
- Segredos de MFA e webhooks criptografados com AES-256-GCM usando chave independente do banco.
- Queries Prisma parametrizadas, schema Zod, escopos explícitos e isolamento por tenant/instância.
- Limites de tamanho e timeout para coleta; redirects revalidados; destinos externos limitados a hosts permitidos e IPs públicos.
- Browser Worker separado da API e executado em rede Docker isolada.

Antes de colocar workers de navegador em produção, aplique política de egress na infraestrutura para bloquear redes privadas, link-local, metadata endpoints e ranges internos também no nível de rede. O isolamento do Compose não substitui firewall de saída.

Use `pnpm audit` e atualize dependências antes de cada release. Valide segurança, capacidade, conectividade, backups e recuperação no ambiente de destino antes de liberar tráfego de produção.
