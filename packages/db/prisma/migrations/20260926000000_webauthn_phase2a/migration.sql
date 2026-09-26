-- Additive WebAuthn Phase 2A evidence. Existing approval and financial semantics are unchanged.
CREATE TABLE "ApprovalEvidence" (
    "id" TEXT NOT NULL,
    "approvalId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "financialPlanId" TEXT NOT NULL,
    "goalContractKey" TEXT NOT NULL,
    "goalContractVersion" INTEGER NOT NULL,
    "goalContractHash" TEXT NOT NULL,
    "financialPlanHash" TEXT NOT NULL,
    "bankStateVersion" INTEGER NOT NULL,
    "webAuthnCredentialId" TEXT NOT NULL,
    "challengeId" TEXT NOT NULL,
    "approvalPayloadHash" TEXT NOT NULL,
    "authenticatorCounterBefore" BIGINT NOT NULL,
    "authenticatorCounterAfter" BIGINT NOT NULL,
    "userVerified" BOOLEAN NOT NULL,
    "rpId" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "verifiedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApprovalEvidence_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ApprovalEvidence_approvalId_key" ON "ApprovalEvidence"("approvalId");
CREATE UNIQUE INDEX "ApprovalEvidence_challengeId_key" ON "ApprovalEvidence"("challengeId");
CREATE INDEX "ApprovalEvidence_userId_createdAt_idx" ON "ApprovalEvidence"("userId", "createdAt");
CREATE INDEX "ApprovalEvidence_financialPlanId_idx" ON "ApprovalEvidence"("financialPlanId");
CREATE INDEX "ApprovalEvidence_webAuthnCredentialId_idx" ON "ApprovalEvidence"("webAuthnCredentialId");

ALTER TABLE "ApprovalEvidence" ADD CONSTRAINT "ApprovalEvidence_approvalId_fkey" FOREIGN KEY ("approvalId") REFERENCES "Approval"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ApprovalEvidence" ADD CONSTRAINT "ApprovalEvidence_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ApprovalEvidence" ADD CONSTRAINT "ApprovalEvidence_financialPlanId_fkey" FOREIGN KEY ("financialPlanId") REFERENCES "FinancialPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ApprovalEvidence" ADD CONSTRAINT "ApprovalEvidence_webAuthnCredentialId_fkey" FOREIGN KEY ("webAuthnCredentialId") REFERENCES "WebAuthnCredential"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ApprovalEvidence" ADD CONSTRAINT "ApprovalEvidence_challengeId_fkey" FOREIGN KEY ("challengeId") REFERENCES "WebAuthnChallenge"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
