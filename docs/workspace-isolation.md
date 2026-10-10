# Evolução arquitetural — espaços de trabalho independentes

## Estado atual verificado

O Scout utiliza um PostgreSQL compartilhado com organização de dados por \`tenantId\` (identificador interno). Usuários são associados a organizações por papéis, e instâncias, fontes, jobs, webhooks e integrações são segregados nas consultas pelo identificador da organização. Esta implementação constitui **isolamento lógico**, não um banco PostgreSQL por organização. O domínio atualmente identifica o Manager público, mas não provê domínios dedicados para cada organização.

Essas propriedades não podem ser promovidas como isolamento físico antes de uma migração de arquitetura. O modelo de acesso continua funcional durante a evolução e preserva os dados existentes.

## Arquitetura alvo

1. **Control Plane:** cadastro de organizações, seus responsáveis, planos, domínios, estado de provisionamento, conexões e auditoria. O administrador principal fica em um banco de controle e não pode ser gerenciado por administradores de organizações.
2. **Banco dedicado por organização:** criar banco e usuário PostgreSQL separados, com privilégios mínimos, migrations controladas, chaves próprias e back-end com seleção da conexão somente após autenticação e resolução do domínio. Nunca aceitar identificador de banco vindo diretamente do cliente.
3. **Domínio por organização:** domínio padrão derivado de slug validado (ex.: \`cliente.scout.example.com\`) e domínio personalizado opcional com comprovação DNS, TLS, validação do hostname e prevenção de apropriação de subdomínios.
4. **Instâncias e integrações independentes:** registros, credenciais criptografadas, webhooks, filas, workers, buckets e artefatos de cada organização isolados. Um responsável pode ter acesso a vários espaços; a troca de espaço deve renovar a sessão e verificar o vínculo.
5. **Convites e identidade:** token de uso único com hash persistido, expiração, revogação, e-mail verificado via link, escolha de senha pelo destinatário, MFA quando exigido e papel mínimo necessário. Não enviar senhas prontas por e-mail.
6. **Provisionamento assíncrono:** máquina de estados REQUESTED → VALIDATING → CREATING_DB → MIGRATING → CONFIGURING_STORAGE → DNS_PENDING/TLS_PENDING → ACTIVE; falhas em ERROR com possibilidade de retentativa idempotente e compensação, sem exclusão automática de dados.
7. **Segurança e isolamento:** testes automatizados demonstrando ausência de leituras cruzadas no banco e no S3; autorização escopada, segregação de chaves, rotação de segredos, quotas, limites de concorrência, proteção anti-SSRF e testes de host spoofing.
8. **Operação:** backup e restauração por organização, métricas e logs com correlação por requestId, retenção configurável, verificação de restauração, observabilidade de workers e um procedimento de exportação/migração de organizações já existentes.

## Etapas de migração sem interrupção ou perda de dados

- **Preparação:** manter o banco atual e registrar a organização de origem, volumes, credenciais e contagem de entidades.
- **Provisionar bancos novos:** criar destino separado, aplicar Prisma migrations e inicializar contas técnicas.
- **Cópia verificável:** migrar tabelas relacionais em ordem de dependência, artefatos S3 e integrações com checagens de cardinalidade e SHA-256; nunca copiar senhas em claro.
- **Janela de corte:** bloquear escrita da organização por curto período, reproduzir alterações finais, verificar integridade, alternar resolução de dados com recurso de rollback.
- **Validação:** autenticação, MFA, Jobs, webhooks, Connect|API, cron, histórico, retenções, logs e restauração por organização. Não ativar roteamento de produção antes de passar nos testes.
- **Desativação da origem:** somente após período de observação e backup válido. Nunca executar \`down -v\`, remover volumes ou apagar dados por mudança de configuração.

## Vocabulário da interface

Não apresentar termos técnicos internos como tenant, banco, schema, cluster ou runtime a usuários comuns. Exibir **Espaço de trabalho**, **Organização**, **Instância**, **Integração** e **Acesso**, com explicações curtas. Nomenclatura interna de código pode permanecer técnica por clareza.

## Critério de conclusão

Somente considerar um novo espaço totalmente independente quando banco dedicado, domínio ativo, contas convidadas, instâncias, integrações, backup, logs, restauração e isolamento cruzado estiverem implementados e comprovados por testes de integração reais. Até lá, utilizar rótulo e documentação honestos para isolamento lógico.
