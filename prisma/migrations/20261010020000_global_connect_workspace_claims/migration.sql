-- A URL e o token administrativos passam a ser globais, vindos exclusivamente do .env da API.
-- As credenciais legadas permanecem intactas, mas ficam desativadas (sem leitura pela API).
-- Não vincular instâncias antigas automaticamente: elas podem apontar para Connect APIs diferentes.
-- O responsável poderá revalidá-las com o token particular de cada instância.
ALTER TABLE "Tenant" ADD COLUMN "connectDefaultInstanceName" VARCHAR(120);
ALTER TABLE "ConnectApiInstance" ADD COLUMN "displayName" VARCHAR(120);

UPDATE "Tenant" AS t
SET "connectDefaultInstanceName" = c."defaultInstanceName"
FROM "ConnectApiConfig" AS c
WHERE c."tenantId" = t."id";

CREATE TABLE "ConnectInstanceClaim" (
  "name" VARCHAR(120) NOT NULL,
  "tenantId" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ConnectInstanceClaim_pkey" PRIMARY KEY ("name")
);
CREATE INDEX "ConnectInstanceClaim_tenantId_idx" ON "ConnectInstanceClaim"("tenantId");
CREATE INDEX "ConnectApiInstance_tenantId_displayName_idx" ON "ConnectApiInstance"("tenantId","displayName");
ALTER TABLE "ConnectInstanceClaim"
 ADD CONSTRAINT "ConnectInstanceClaim_tenantId_fkey"
 FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
