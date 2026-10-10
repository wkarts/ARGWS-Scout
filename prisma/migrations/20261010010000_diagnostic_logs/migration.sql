CREATE TABLE "DiagnosticLog" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "requestId" VARCHAR(100) NOT NULL,
  "method" VARCHAR(10) NOT NULL,
  "route" VARCHAR(200) NOT NULL,
  "statusCode" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DiagnosticLog_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "DiagnosticLog_tenantId_createdAt_idx" ON "DiagnosticLog"("tenantId", "createdAt");
CREATE INDEX "DiagnosticLog_tenantId_statusCode_createdAt_idx" ON "DiagnosticLog"("tenantId", "statusCode", "createdAt");
ALTER TABLE "DiagnosticLog" ADD CONSTRAINT "DiagnosticLog_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
