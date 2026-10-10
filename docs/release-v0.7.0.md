# ARGWS Scout v0.7.0 — Modelos prontos de instância

A v0.7.0 sucede a v0.6.1 e inclui todo o histórico anterior de responsividade, uma única conexão global Connect|API, segurança de contas, convites, diagnósticos e documentação online.

## Recursos novos

- **Dez modelos iniciais editáveis:** Mercado Livre, Shopee, Amazon Brasil, Magazine Luiza, AliExpress, KaBuM!, OLX Brasil, Buscapé, eBay e site genérico.
- **Novo menu Modelos prontos:** busca, filtro por categoria e assistente com nome, termo pesquisado, fonte, engine HTTP ou navegador, seletor CSS, intervalo e URL opcional para personalizar.
- **Clonagem por espaço:** criação atômica de instância e primeira fonte no espaço autenticado, sem disparar coleta automaticamente; slug exclusivo e metadados do modelo e sua versão.
- **Edição posterior:** a fonte clonada pode ter URL, allowlist de hosts, motor de coleta, captura de tela, seletores, intervalo e estado ajustados dentro do Manager.
- **Segurança preservada:** URL pública validada com anti-SSRF, hosts permitidos, coleta responsável com robots.txt obrigatório na criação a partir do catálogo; nenhuma credencial de marketplace embutida.
- **Documentação online:** guia `/docs/viewer.html?doc=instance-templates` disponível diretamente no navegador, referência OpenAPI dos endpoints `/instance-templates`, manuais atualizados.
- **Validação:** testes unitários do catálogo e regras de URL, testes PostgreSQL de segregação por espaço, smoke real Chromium da galeria em resoluções de 320px a 1920px e verificações de integridade dos deploys.

## Limitações conhecidas

Os modelos são **configurações iniciais de páginas públicas**, não integrações completas oficiais com APIs comerciais de marketplaces. HTML, seletores e disponibilidade dependem de cada site e podem mudar ou exigir autorização. O Scout não contorna bloqueios, paywalls, login, CAPTCHA ou robots.txt; não deve coletar páginas sem permissão. Para catálogo, pedidos e preços autenticados use APIs oficiais, cujos mecanismos de OAuth e homologação não fazem parte desta release.

O isolamento das organizações permanece lógico no PostgreSQL compartilhado. Banco e domínio individuais permanecem pendentes na [issue #30](https://github.com/wkarts/ARGWS-Scout/issues/30).

## Instalação e upgrade sem perda de dados

1. Faça backup consistente do PostgreSQL, Garage e do `.env`, confirmando que uma restauração funciona.
2. Preserve `COMPOSE_PROJECT_NAME`, MFA, credenciais, chaves, todos os diretórios `./volumes` e a porta externa de produção configurada (`48181` no Dockge). Não use `docker compose down -v`.
3. Atualize os manifests e as imagens de todos os componentes para a mesma tag `0.7.0`, execute as migrations existentes (sem migrations novas para o catálogo) e aguarde os healthchecks.
4. Em Modelos prontos, crie uma instância experimental para o espaço atual, confirme que a fonte pode ser editada e execute a coleta manual de uma página permitida.
5. Confirme login, MFA, usuário principal protegido, convites, instâncias WhatsApp por espaço, Connect|API, agendamentos, docs e logs de diagnóstico.
6. Após validar, gere novo backup.

O lançamento no GitHub e no GHCR **não modifica automaticamente** sua stack Dockge, CloudPanel ou Portainer.

## Referências

- [Manual dos modelos](instance-templates.md).
- [Guia de implantação](deployment.md).
- [Catálogo de APIs online](/docs/viewer.html?doc=openapi).
