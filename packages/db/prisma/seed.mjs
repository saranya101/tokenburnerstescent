import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";

const userId = process.env.PARLANCE_CUSTOMER_USER_ID;
if (!userId) throw new Error("PARLANCE_CUSTOMER_USER_ID_MISSING");

const db = new PrismaClient();
const groundingFixture = JSON.parse(readFileSync(new URL("./demo-grounding-fixture.json", import.meta.url), "utf8"));

const accounts = [
  {
    id: "acc-sgd",
    providerRef: "acc-sgd",
    type: "CHECKING",
    currency: "SGD",
    ledgerMinorUnits: 2_000_000n,
    availableMinorUnits: 2_000_000n,
    status: "ACTIVE",
    capabilities: ["SEND_TRANSFER", "RECEIVE_TRANSFER", "CONVERT_FX", "PAY_BILL", "TRADE_ASSET"],
    stateVersion: 7,
  },
  {
    id: "acc-usd",
    providerRef: "acc-usd",
    type: "CHECKING",
    currency: "USD",
    ledgerMinorUnits: 500_000n,
    availableMinorUnits: 500_000n,
    status: "ACTIVE",
    capabilities: ["SEND_TRANSFER", "RECEIVE_TRANSFER", "CONVERT_FX", "TRADE_ASSET"],
    stateVersion: 7,
  },
];

const beneficiaries = groundingFixture.beneficiaries;
const aliases = groundingFixture.aliases;
const asset = groundingFixture.asset;

function aliasId(entityType, entityId, alias) {
  const digest = createHash("sha256").update(`${userId}\0${entityType}\0${entityId}\0${alias}`).digest("hex").slice(0, 24);
  return `demo-alias-${digest}`;
}

try {
  await db.$transaction(async (tx) => {
    await tx.user.upsert({ where: { id: userId }, create: { id: userId }, update: {} });

    await tx.userRiskProfile.upsert({
      where: { userId },
      create: { userId, kycStatus: "VERIFIED", version: 1 },
      update: {},
    });

    for (const account of accounts) {
      await tx.account.upsert({
        where: { id: account.id },
        create: { ...account, userId },
        update: { ...account, userId },
      });
    }

    for (const beneficiary of beneficiaries) {
      await tx.beneficiary.upsert({
        where: { id: beneficiary.id },
        create: { ...beneficiary, userId, status: "ACTIVE", version: 1 },
        update: { ...beneficiary, userId, status: "ACTIVE", version: 1 },
      });
    }

    await tx.asset.upsert({
      where: { id: asset.id },
      create: asset,
      update: asset,
    });

    for (const [entityType, entityId, alias] of aliases) {
      await tx.entityAlias.upsert({
        where: { id: aliasId(entityType, entityId, alias) },
        create: { id: aliasId(entityType, entityId, alias), userId, entityType, entityId, alias },
        update: { userId, entityType, entityId, alias },
      });
    }
  });

  console.log(`Demo grounding data ready: ${accounts.length} accounts, ${beneficiaries.length} beneficiaries, 1 asset, ${aliases.length} aliases.`);
} finally {
  await db.$disconnect();
}
