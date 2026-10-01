-- CreateEnum
CREATE TYPE "WhatsAppPublicationStatus" AS ENUM ('PENDING', 'SENDING', 'SENT', 'FAILED', 'UNKNOWN');

-- CreateTable
CREATE TABLE "ConnectApiConfig" (
    "tenantId" UUID NOT NULL,
    "baseUrl" VARCHAR(2048) NOT NULL,
    "apiKeyEncrypted" TEXT NOT NULL,
    "defaultInstanceName" VARCHAR(120),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConnectApiConfig_pkey" PRIMARY KEY ("tenantId")
);

-- CreateTable
CREATE TABLE "ConnectApiInstance" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "integration" VARCHAR(40) NOT NULL DEFAULT 'WHATSAPP-BAILEYS',
    "tokenEncrypted" TEXT,
    "connectionState" VARCHAR(40),
    "number" VARCHAR(32),
    "profileName" VARCHAR(120),
    "present" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConnectApiInstance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhatsAppPublication" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "jobId" UUID,
    "createdById" UUID,
    "requestId" VARCHAR(80) NOT NULL,
    "instanceName" VARCHAR(120) NOT NULL,
    "recipientEncrypted" TEXT NOT NULL,
    "messageEncrypted" TEXT NOT NULL,
    "status" "WhatsAppPublicationStatus" NOT NULL DEFAULT 'PENDING',
    "statusCode" INTEGER,
    "errorCode" VARCHAR(80),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "WhatsAppPublication_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ConnectApiConfig_updatedAt_idx" ON "ConnectApiConfig"("updatedAt");
CREATE UNIQUE INDEX "ConnectApiInstance_tenantId_name_key" ON "ConnectApiInstance"("tenantId", "name");
CREATE INDEX "ConnectApiInstance_tenantId_present_connectionState_idx" ON "ConnectApiInstance"("tenantId", "present", "connectionState");
CREATE UNIQUE INDEX "WhatsAppPublication_tenantId_requestId_key" ON "WhatsAppPublication"("tenantId", "requestId");
CREATE INDEX "WhatsAppPublication_tenantId_createdAt_idx" ON "WhatsAppPublication"("tenantId", "createdAt");
CREATE INDEX "WhatsAppPublication_jobId_createdAt_idx" ON "WhatsAppPublication"("jobId", "createdAt");

-- AddForeignKey
ALTER TABLE "ConnectApiConfig" ADD CONSTRAINT "ConnectApiConfig_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConnectApiInstance" ADD CONSTRAINT "ConnectApiInstance_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WhatsAppPublication" ADD CONSTRAINT "WhatsAppPublication_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WhatsAppPublication" ADD CONSTRAINT "WhatsAppPublication_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "WhatsAppPublication" ADD CONSTRAINT "WhatsAppPublication_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
