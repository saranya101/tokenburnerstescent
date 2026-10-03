CREATE TABLE "GoalBundleContract" (
    "id" TEXT NOT NULL,
    "bundleKey" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "userId" TEXT NOT NULL,
    "sourceIntentDraftId" TEXT NOT NULL,
    "status" "GoalStatus" NOT NULL,
    "schemaVersion" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "contractHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "GoalBundleContract_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GoalBundleContract_sourceIntentDraftId_key" ON "GoalBundleContract"("sourceIntentDraftId");
CREATE UNIQUE INDEX "GoalBundleContract_bundleKey_version_key" ON "GoalBundleContract"("bundleKey", "version");
CREATE INDEX "GoalBundleContract_userId_status_idx" ON "GoalBundleContract"("userId", "status");

ALTER TABLE "GoalBundleContract" ADD CONSTRAINT "GoalBundleContract_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "GoalBundleContract" ADD CONSTRAINT "GoalBundleContract_sourceIntentDraftId_fkey" FOREIGN KEY ("sourceIntentDraftId") REFERENCES "IntentDraftRecord"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "FinancialPlan" ALTER COLUMN "goalContractRowId" DROP NOT NULL;
ALTER TABLE "FinancialPlan" ADD COLUMN "goalBundleRowId" TEXT;
ALTER TABLE "FinancialPlan" ADD COLUMN "satisfactionProof" JSONB;
CREATE INDEX "FinancialPlan_goalBundleRowId_status_idx" ON "FinancialPlan"("goalBundleRowId", "status");
ALTER TABLE "FinancialPlan" ADD CONSTRAINT "FinancialPlan_goalBundleRowId_fkey" FOREIGN KEY ("goalBundleRowId") REFERENCES "GoalBundleContract"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FinancialPlan" ADD CONSTRAINT "FinancialPlan_exactly_one_goal_owner" CHECK (("goalContractRowId" IS NOT NULL) <> ("goalBundleRowId" IS NOT NULL));

ALTER TABLE "Approval" ALTER COLUMN "goalContractRowId" DROP NOT NULL;
ALTER TABLE "Approval" ADD COLUMN "goalBundleRowId" TEXT;
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_goalBundleRowId_fkey" FOREIGN KEY ("goalBundleRowId") REFERENCES "GoalBundleContract"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_exactly_one_goal_owner" CHECK (("goalContractRowId" IS NOT NULL) <> ("goalBundleRowId" IS NOT NULL));
