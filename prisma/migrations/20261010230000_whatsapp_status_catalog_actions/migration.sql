-- Log mínimo de ações externas: não persiste conteúdo, credenciais nem números completos.
-- Mantém idempotência de publicação por espaço de trabalho.
CREATE TABLE "ChannelAction" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "remoteInstance" VARCHAR(120) NOT NULL,
  "kind" VARCHAR(32) NOT NULL,
  "requestId" VARCHAR(80) NOT NULL,
  "payloadHash" CHAR(64) NOT NULL,
  "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  "errorCode" VARCHAR(80),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "sentAt" TIMESTAMP(3),
  CONSTRAINT "ChannelAction_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ChannelAction_status_check" CHECK ("status" IN ('PENDING','SENT','FAILED','UNKNOWN'))
);
CREATE UNIQUE INDEX "ChannelAction_tenantId_requestId_key" ON "ChannelAction"("tenantId","requestId");
CREATE INDEX "ChannelAction_tenantId_createdAt_idx" ON "ChannelAction"("tenantId","createdAt");
ALTER TABLE "ChannelAction" ADD CONSTRAINT "ChannelAction_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
