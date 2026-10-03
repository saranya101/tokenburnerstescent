CREATE TYPE "KycStatus" AS ENUM (
    'VERIFIED',
    'REVIEW_REQUIRED',
    'BLOCKED'
);

CREATE TYPE "RiskDecision" AS ENUM (
    'ALLOW',
    'REVIEW',
    'BLOCK'
);

CREATE TYPE "RiskReservationStatus" AS ENUM (
    'ACTIVE',
    'CONSUMED',
    'RELEASED',
    'EXPIRED'
);

CREATE TYPE "RiskVelocityEntryStatus" AS ENUM (
    'RESERVED',
    'SETTLED',
    'RELEASED',
    'EXPIRED'
);

CREATE TABLE "UserRiskProfile" (
    "userId" TEXT NOT NULL,
    "kycStatus" "KycStatus" NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserRiskProfile_pkey" PRIMARY KEY ("userId")
);

CREATE TABLE "RiskAssessment" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "financialPlanId" TEXT NOT NULL,
    "financialPlanHash" TEXT NOT NULL,
    "bankStateVersion" INTEGER NOT NULL,
    "policyVersion" TEXT NOT NULL,
    "kycStatus" "KycStatus" NOT NULL,
    "decision" "RiskDecision" NOT NULL,
    "reasonCodes" JSONB NOT NULL,
    "exposures" JSONB NOT NULL,
    "rollingUsage" JSONB NOT NULL,
    "assessedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "traceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RiskAssessment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RiskReservation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "assessmentId" TEXT NOT NULL,
    "financialPlanId" TEXT NOT NULL,
    "financialPlanHash" TEXT NOT NULL,
    "policyVersion" TEXT NOT NULL,
    "status" "RiskReservationStatus" NOT NULL DEFAULT 'ACTIVE',
    "traceId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "releasedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RiskReservation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RiskVelocityEntry" (
    "id" TEXT NOT NULL,
    "reservationId" TEXT NOT NULL,
    "stepId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "minorUnits" BIGINT NOT NULL,
    "status" "RiskVelocityEntryStatus" NOT NULL DEFAULT 'RESERVED',
    "settledAt" TIMESTAMP(3),
    "releasedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RiskVelocityEntry_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RiskReservation_assessmentId_key"
ON "RiskReservation"("assessmentId");

CREATE INDEX "RiskAssessment_userId_assessedAt_idx"
ON "RiskAssessment"("userId", "assessedAt");

CREATE INDEX "RiskAssessment_financialPlanId_assessedAt_idx"
ON "RiskAssessment"("financialPlanId", "assessedAt");

CREATE INDEX "RiskAssessment_decision_expiresAt_idx"
ON "RiskAssessment"("decision", "expiresAt");

CREATE INDEX "RiskReservation_userId_status_expiresAt_idx"
ON "RiskReservation"("userId", "status", "expiresAt");

CREATE INDEX "RiskReservation_financialPlanId_status_idx"
ON "RiskReservation"("financialPlanId", "status");

CREATE UNIQUE INDEX "RiskVelocityEntry_reservationId_stepId_key"
ON "RiskVelocityEntry"("reservationId", "stepId");

CREATE INDEX "RiskVelocityEntry_status_currency_createdAt_idx"
ON "RiskVelocityEntry"("status", "currency", "createdAt");

CREATE INDEX "RiskVelocityEntry_reservationId_status_idx"
ON "RiskVelocityEntry"("reservationId", "status");

ALTER TABLE "UserRiskProfile"
ADD CONSTRAINT "UserRiskProfile_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "RiskAssessment"
ADD CONSTRAINT "RiskAssessment_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "RiskAssessment"
ADD CONSTRAINT "RiskAssessment_financialPlanId_fkey"
FOREIGN KEY ("financialPlanId") REFERENCES "FinancialPlan"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "RiskReservation"
ADD CONSTRAINT "RiskReservation_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "RiskReservation"
ADD CONSTRAINT "RiskReservation_assessmentId_fkey"
FOREIGN KEY ("assessmentId") REFERENCES "RiskAssessment"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "RiskReservation"
ADD CONSTRAINT "RiskReservation_financialPlanId_fkey"
FOREIGN KEY ("financialPlanId") REFERENCES "FinancialPlan"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "RiskVelocityEntry"
ADD CONSTRAINT "RiskVelocityEntry_reservationId_fkey"
FOREIGN KEY ("reservationId") REFERENCES "RiskReservation"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
