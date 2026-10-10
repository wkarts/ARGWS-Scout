-- Protege a identidade da instalação sem redefinir senha, MFA ou usuários existentes.
ALTER TABLE "User" ADD COLUMN "isPlatformMaster" BOOLEAN NOT NULL DEFAULT false;

-- Convites são credenciais temporárias com somente o hash persistido.
CREATE TABLE "UserInvitation" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "invitedByUserId" UUID NOT NULL,
  "name" VARCHAR(120) NOT NULL,
  "email" VARCHAR(254) NOT NULL,
  "role" "TenantRole" NOT NULL DEFAULT 'VIEWER',
  "independentWorkspace" BOOLEAN NOT NULL DEFAULT true,
  "workspaceName" VARCHAR(120),
  "tokenHash" CHAR(64) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "acceptedAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "UserInvitation_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "UserInvitation_tokenHash_key" ON "UserInvitation"("tokenHash");
CREATE INDEX "UserInvitation_tenantId_email_createdAt_idx" ON "UserInvitation"("tenantId", "email", "createdAt");
CREATE INDEX "UserInvitation_expiresAt_acceptedAt_revokedAt_idx" ON "UserInvitation"("expiresAt", "acceptedAt", "revokedAt");
ALTER TABLE "UserInvitation" ADD CONSTRAINT "UserInvitation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UserInvitation" ADD CONSTRAINT "UserInvitation_invitedByUserId_fkey" FOREIGN KEY ("invitedByUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
