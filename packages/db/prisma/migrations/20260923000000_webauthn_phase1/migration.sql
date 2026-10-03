-- Additive WebAuthn Phase 1 persistence. No existing financial rows are modified.
CREATE TYPE "WebAuthnChallengePurpose" AS ENUM ('REGISTRATION', 'APPROVAL');
CREATE TYPE "WebAuthnChallengeStatus" AS ENUM ('ISSUED', 'CONSUMED', 'REVOKED', 'EXPIRED');

CREATE TABLE "WebAuthnCredential" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "publicKey" BYTEA NOT NULL,
    "userHandle" BYTEA NOT NULL,
    "signCount" BIGINT NOT NULL,
    "transports" JSONB,
    "deviceType" TEXT NOT NULL,
    "backedUp" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "WebAuthnCredential_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "WebAuthnChallenge" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "purpose" "WebAuthnChallengePurpose" NOT NULL,
    "challenge" TEXT NOT NULL,
    "userHandle" BYTEA,
    "expectedRpId" TEXT NOT NULL,
    "expectedOrigin" TEXT NOT NULL,
    "status" "WebAuthnChallengeStatus" NOT NULL DEFAULT 'ISSUED',
    "financialPlanId" TEXT,
    "approvalPayload" JSONB,
    "approvalPayloadHash" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebAuthnChallenge_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WebAuthnCredential_credentialId_key" ON "WebAuthnCredential"("credentialId");
CREATE INDEX "WebAuthnCredential_userId_revokedAt_idx" ON "WebAuthnCredential"("userId", "revokedAt");
CREATE UNIQUE INDEX "WebAuthnChallenge_challenge_key" ON "WebAuthnChallenge"("challenge");
CREATE INDEX "WebAuthnChallenge_userId_purpose_status_idx" ON "WebAuthnChallenge"("userId", "purpose", "status");
CREATE INDEX "WebAuthnChallenge_status_expiresAt_idx" ON "WebAuthnChallenge"("status", "expiresAt");
CREATE INDEX "WebAuthnChallenge_financialPlanId_idx" ON "WebAuthnChallenge"("financialPlanId");

ALTER TABLE "WebAuthnCredential" ADD CONSTRAINT "WebAuthnCredential_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WebAuthnChallenge" ADD CONSTRAINT "WebAuthnChallenge_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WebAuthnChallenge" ADD CONSTRAINT "WebAuthnChallenge_financialPlanId_fkey" FOREIGN KEY ("financialPlanId") REFERENCES "FinancialPlan"("id") ON DELETE SET NULL ON UPDATE CASCADE;
