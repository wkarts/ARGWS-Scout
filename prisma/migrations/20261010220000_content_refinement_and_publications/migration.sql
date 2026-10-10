-- Inclusão isolada; nenhuma tabela existente recebe colunas obrigatórias.
CREATE TYPE "ContentBatchStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED');
CREATE TYPE "ContentReviewStatus" AS ENUM ('DRAFT', 'REVIEW', 'APPROVED', 'ARCHIVED');
CREATE TABLE "ContentBatch" (
    "id" UUID NOT NULL, "tenantId" UUID NOT NULL, "instanceId" UUID NOT NULL,
    "jobId" UUID NOT NULL, "status" "ContentBatchStatus" NOT NULL DEFAULT 'QUEUED',
    "options" JSONB NOT NULL DEFAULT '{}', "total" INTEGER NOT NULL DEFAULT 0,
    "reviewRequired" INTEGER NOT NULL DEFAULT 0, "attempts" INTEGER NOT NULL DEFAULT 0,
    "errorCode" VARCHAR(80), "startedAt" TIMESTAMP(3), "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ContentBatch_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "ContentIdentity" (
    "id" UUID NOT NULL, "tenantId" UUID NOT NULL, "instanceId" UUID NOT NULL,
    "originHost" VARCHAR(255) NOT NULL, "externalKey" VARCHAR(190) NOT NULL,
    "title" VARCHAR(500) NOT NULL, "url" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ContentIdentity_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "ContentEntry" (
    "id" UUID NOT NULL, "batchId" UUID NOT NULL, "identityId" UUID NOT NULL,
    "sourceRecordId" VARCHAR(190) NOT NULL, "title" VARCHAR(500) NOT NULL,
    "kind" VARCHAR(64) NOT NULL, "url" TEXT, "price" DECIMAL(18,2),
    "normalized" JSONB NOT NULL, "channels" JSONB NOT NULL DEFAULT '{}',
    "images" JSONB NOT NULL DEFAULT '{}', "warnings" JSONB NOT NULL DEFAULT '[]',
    "reviewStatus" "ContentReviewStatus" NOT NULL DEFAULT 'DRAFT',
    "reviewedAt" TIMESTAMP(3), "reviewedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ContentEntry_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "ContentObservation" (
    "id" UUID NOT NULL, "identityId" UUID NOT NULL, "jobId" UUID NOT NULL,
    "price" DECIMAL(18,2), "previousPrice" DECIMAL(18,2),
    "capturedAt" TIMESTAMP(3), "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ContentObservation_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ContentBatch_jobId_key" ON "ContentBatch"("jobId");
CREATE INDEX "ContentBatch_tenantId_createdAt_idx" ON "ContentBatch"("tenantId", "createdAt");
CREATE INDEX "ContentBatch_instanceId_status_createdAt_idx" ON "ContentBatch"("instanceId", "status", "createdAt");
CREATE UNIQUE INDEX "ContentIdentity_instanceId_originHost_externalKey_key" ON "ContentIdentity"("instanceId", "originHost", "externalKey");
CREATE INDEX "ContentIdentity_tenantId_originHost_idx" ON "ContentIdentity"("tenantId", "originHost");
CREATE UNIQUE INDEX "ContentEntry_batchId_sourceRecordId_key" ON "ContentEntry"("batchId", "sourceRecordId");
CREATE INDEX "ContentEntry_batchId_reviewStatus_idx" ON "ContentEntry"("batchId", "reviewStatus");
CREATE INDEX "ContentEntry_identityId_createdAt_idx" ON "ContentEntry"("identityId", "createdAt");
CREATE UNIQUE INDEX "ContentObservation_identityId_jobId_key" ON "ContentObservation"("identityId", "jobId");
CREATE INDEX "ContentObservation_identityId_observedAt_idx" ON "ContentObservation"("identityId", "observedAt");
ALTER TABLE "ContentBatch" ADD CONSTRAINT "ContentBatch_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ContentBatch" ADD CONSTRAINT "ContentBatch_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "Instance"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ContentBatch" ADD CONSTRAINT "ContentBatch_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ContentIdentity" ADD CONSTRAINT "ContentIdentity_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ContentIdentity" ADD CONSTRAINT "ContentIdentity_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "Instance"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ContentEntry" ADD CONSTRAINT "ContentEntry_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "ContentBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ContentEntry" ADD CONSTRAINT "ContentEntry_identityId_fkey" FOREIGN KEY ("identityId") REFERENCES "ContentIdentity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ContentObservation" ADD CONSTRAINT "ContentObservation_identityId_fkey" FOREIGN KEY ("identityId") REFERENCES "ContentIdentity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ContentObservation" ADD CONSTRAINT "ContentObservation_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;
