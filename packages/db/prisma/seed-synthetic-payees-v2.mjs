import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";

const databaseUrl = process.env.TEST_DATABASE_URL;
const userId = process.env.PARLANCE_CUSTOMER_USER_ID;
if (process.env.PARLANCE_LOCAL_TEST_MODE !== "true" || process.env.PARLANCE_SYNTHETIC_PAYEES_V2 !== "true") throw new Error("ISOLATED_SYNTHETIC_FIXTURE_NOT_ENABLED");
if (!databaseUrl || !userId || databaseUrl === process.env.DATABASE_URL) throw new Error("DEDICATED_TEST_DATABASE_AND_CUSTOMER_REQUIRED");
const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
if (!/(?:test|disposable|isolated)/iu.test(databaseName)) throw new Error("TEST_DATABASE_NAME_REQUIRED");

const fixture = JSON.parse(readFileSync(new URL("./synthetic-payees-v2.json", import.meta.url), "utf8"));
const db = new PrismaClient({ datasourceUrl: databaseUrl });
try {
  await db.$transaction(async (tx) => {
    if (!await tx.user.findUnique({ where: { id: userId }, select: { id: true } })) throw new Error("TEST_CUSTOMER_NOT_FOUND");
    for (const beneficiary of fixture.beneficiaries) {
      const existing = await tx.beneficiary.findUnique({ where: { id: beneficiary.id }, select: { userId: true } });
      if (existing && existing.userId !== userId) throw new Error("BENEFICIARY_ID_OWNED_BY_ANOTHER_CUSTOMER");
      await tx.beneficiary.upsert({ where: { id: beneficiary.id },
        create: { ...beneficiary, userId, status: "ACTIVE", version: 1 },
        update: { providerRef: beneficiary.providerRef, name: beneficiary.name, supportedCurrencies: beneficiary.supportedCurrencies, status: "ACTIVE" },
      });
    }
    for (const [entityType, entityId, alias] of fixture.aliases) {
      const digest = createHash("sha256").update(`${userId}\0${entityType}\0${entityId}\0${alias}`).digest("hex").slice(0, 24);
      const id = `demo-alias-${digest}`;
      await tx.entityAlias.upsert({ where: { id }, create: { id, userId, entityType, entityId, alias }, update: { alias } });
    }
  });
  console.log(`Added ${fixture.beneficiaries.length} synthetic payees to the isolated test customer.`);
} finally {
  await db.$disconnect();
}
