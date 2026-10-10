# Serviço opcional de conteúdo

Adaptado do Motor de Publicações 2.0.0. Apenas a rede privada da stack deve alcançar este serviço.

POST /v1/process gera um lote na pasta privada; GET /v1/jobs/{job_id}/manifest obtém os metadados. O worker do Scout salva as peças no Garage e passa a controlar o acesso via API autenticada da organização.

**Não há disparo de mensagens neste serviço.**

As funções de download opcional de mídia aceitam apenas destinos HTTPS com IP público, mas permanecem desabilitadas por padrão. Arquivos de páginas/scraping são dados não confiáveis.
