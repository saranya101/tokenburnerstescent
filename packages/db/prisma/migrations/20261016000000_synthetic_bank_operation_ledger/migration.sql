ALTER TABLE "FxQuote" ADD COLUMN "amountMinorUnits" BIGINT;

CREATE TABLE "SyntheticBankOperation" (
    "idempotencyKey" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "bankReference" TEXT NOT NULL,
    "stateVersion" INTEGER NOT NULL,
    "response" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SyntheticBankOperation_pkey" PRIMARY KEY ("idempotencyKey")
);

CREATE UNIQUE INDEX "SyntheticBankOperation_bankReference_key" ON "SyntheticBankOperation"("bankReference");
CREATE INDEX "SyntheticBankOperation_userId_createdAt_idx" ON "SyntheticBankOperation"("userId", "createdAt");
ALTER TABLE "SyntheticBankOperation" ADD CONSTRAINT "SyntheticBankOperation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "SyntheticAssetQuote" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "settlementCurrency" TEXT NOT NULL,
    "unitPriceMinor" BIGINT NOT NULL,
    "feeMinor" BIGINT NOT NULL,
    "stateVersion" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SyntheticAssetQuote_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SyntheticAssetQuote_userId_stateVersion_expiresAt_idx" ON "SyntheticAssetQuote"("userId", "stateVersion", "expiresAt");
ALTER TABLE "SyntheticAssetQuote" ADD CONSTRAINT "SyntheticAssetQuote_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SyntheticAssetQuote" ADD CONSTRAINT "SyntheticAssetQuote_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
