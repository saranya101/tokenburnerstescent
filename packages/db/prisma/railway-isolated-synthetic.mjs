import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { approvedMigrationState } from "./review-migration-policy.mjs";

const projectId = "55d5cb65-c1ce-4431-877c-63d08969713e";
const environmentId = "17977510-a832-4949-b083-e24e4b36c7c6";
const appServiceId = "1ff8b7d4-ab42-4edb-a0b8-988291c8c9ad";
const mode = process.argv[2];
if (!["--inspect", "--seed", "--verify"].includes(mode)) throw new Error("INSPECT_SEED_OR_VERIFY_MODE_REQUIRED");
if (process.env.RAILWAY_PROJECT_ID !== projectId || process.env.RAILWAY_ENVIRONMENT_ID !== environmentId || process.env.RAILWAY_SERVICE_ID !== appServiceId) {
  throw new Error("UNAPPROVED_RAILWAY_TARGET");
}
const url = new URL(process.env.DIRECT_URL ?? "");
const pooledUrl = new URL(process.env.DATABASE_URL ?? "");
for (const target of [url, pooledUrl]) {
  if (!/[Pp]ostgres(?:ql)?:/u.test(target.protocol) || target.hostname !== "postgres.railway.internal" || target.pathname !== "/railway" || target.port && target.port !== "5432") {
    throw new Error("UNAPPROVED_PRIVATE_DATABASE_TARGET");
  }
}
if (url.username !== pooledUrl.username || url.password !== pooledUrl.password) throw new Error("DATABASE_URL_MISMATCH");

const fixture = JSON.parse(readFileSync(new URL("./demo-grounding-fixture.json", import.meta.url), "utf8"));
const expanded = JSON.parse(readFileSync(new URL("./synthetic-payees-v2.json", import.meta.url), "utf8"));
const expectedMigrations = readdirSync(new URL("./migrations/", import.meta.url), { withFileTypes: true })
  .filter((item) => item.isDirectory()).map((item) => item.name).sort();
const db = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

async function databaseState(client) {
  const [identity] = await client.$queryRaw`SELECT current_database() AS database_name, current_schema() AS schema_name`;
  if (identity.database_name !== "railway" || identity.schema_name !== "public") throw new Error("UNAPPROVED_DATABASE_IDENTITY");
  const migrations = await client.$queryRaw`SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations"`;
  const applied = migrations.filter((item) => item.finished_at && !item.rolled_back_at).map((item) => item.migration_name).sort();
  if (!approvedMigrationState(applied, expectedMigrations, process.env) || migrations.some((item) => !item.finished_at && !item.rolled_back_at)) {
    throw new Error("MIGRATION_STATE_NOT_APPROVED");
  }
  const tables = await client.$queryRaw`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name <> '_prisma_migrations' ORDER BY table_name`;
  const counts = {};
  for (const { table_name: table } of tables) {
    const quoted = table.replaceAll('"', '""');
    const [row] = await client.$queryRawUnsafe(`SELECT COUNT(*)::int AS count FROM "public"."${quoted}"`);
    counts[table] = row.count;
  }
  return { migrationCount: applied.length, tableCounts: counts };
}

function aliasId(userId, entityType, entityId, alias) {
  const digest = createHash("sha256").update(`${userId}\0${entityType}\0${entityId}\0${alias}`).digest("hex").slice(0, 24);
  return `demo-alias-${digest}`;
}

try {
  if (mode === "--inspect") {
    const state = await databaseState(db);
    console.log(`ISOLATED_DATABASE_INSPECTION ${JSON.stringify(state)}`);
  } else if (mode === "--verify") {
    const state = await databaseState(db);
    const issuer = process.env.PARLANCE_MOBILE_OIDC_ISSUER;
    const subject = process.env.PARLANCE_AUTH0_TEST_SUB;
    if (!issuer?.startsWith("https://") || !/^auth0\|[A-Za-z0-9]+$/u.test(subject ?? "")) throw new Error("VERIFIED_AUTH0_IDENTITY_REQUIRED");
    const userId = `synthetic-${createHash("sha256").update(`${issuer}\0${subject}`).digest("hex").slice(0, 24)}`;
    const identities = await db.externalIdentity.findMany({ select: { issuer: true, subject: true, userId: true } });
    if (state.tableCounts.User !== 1 || identities.length !== 1 || identities[0].issuer !== issuer || identities[0].subject !== subject || identities[0].userId !== userId) {
      throw new Error("ISOLATED_IDENTITY_MAPPING_MISMATCH");
    }
    const { databaseCustomerSnapshot } = await import("../../../services/mock-bank/dist/database-snapshot.js");
    const snapshot = await databaseCustomerSnapshot(userId);
    const currencies = snapshot.accounts.map((item) => item.currency).sort();
    if (currencies.join(",") !== "SGD,USD" || snapshot.beneficiaries.length !== 15 || snapshot.holdings.length !== 1 || !snapshot.assets.some((item) => item.symbol === "AAPL") || snapshot.assetQuotes.length !== 1) {
      throw new Error("ISOLATED_CUSTOMER_SNAPSHOT_MISMATCH");
    }
    console.log(`ISOLATED_SYNTHETIC_VERIFIED ${JSON.stringify({ identityCount: identities.length, currencies, payeeCount: snapshot.beneficiaries.length, holdingCount: snapshot.holdings.length, quoteCount: snapshot.assetQuotes.length, stateVersion: snapshot.stateVersion })}`);
  } else {
    if (process.env.PARLANCE_ISOLATED_SYNTHETIC_SEED_APPROVED !== "true") throw new Error("EXPLICIT_SYNTHETIC_SEED_APPROVAL_REQUIRED");
    const issuer = process.env.PARLANCE_MOBILE_OIDC_ISSUER;
    const subject = process.env.PARLANCE_AUTH0_TEST_SUB;
    if (!issuer?.startsWith("https://") || !/^auth0\|[A-Za-z0-9]+$/u.test(subject ?? "")) throw new Error("VERIFIED_AUTH0_IDENTITY_REQUIRED");
    const userId = `synthetic-${createHash("sha256").update(`${issuer}\0${subject}`).digest("hex").slice(0, 24)}`;
    await db.$transaction(async (tx) => {
      const [lock] = await tx.$queryRaw`SELECT pg_try_advisory_xact_lock(442227331, 20261015) AS locked`;
      if (!lock.locked) throw new Error("SYNTHETIC_SEED_ALREADY_RUNNING");
      const state = await databaseState(tx);
      console.log(`ISOLATED_DATABASE_PRESEED ${JSON.stringify(state)}`);
      if (Object.values(state.tableCounts).some((count) => count !== 0)) throw new Error("DATABASE_NOT_EMPTY_SEED_ABORTED");

      await tx.user.create({ data: { id: userId } });
      await tx.externalIdentity.create({ data: { issuer, subject, userId } });
      await tx.userRiskProfile.create({ data: { userId, kycStatus: "VERIFIED", version: 1 } });
      for (const account of [
        { id: "acc-sgd", currency: "SGD", minorUnits: 2_000_000n, capabilities: ["SEND_TRANSFER", "RECEIVE_TRANSFER", "CONVERT_FX", "PAY_BILL", "TRADE_ASSET"] },
        { id: "acc-usd", currency: "USD", minorUnits: 500_000n, capabilities: ["SEND_TRANSFER", "RECEIVE_TRANSFER", "CONVERT_FX", "TRADE_ASSET"] },
      ]) await tx.account.create({ data: {
        id: account.id, providerRef: account.id, userId, type: "CHECKING", currency: account.currency,
        ledgerMinorUnits: account.minorUnits, availableMinorUnits: account.minorUnits,
        status: "ACTIVE", capabilities: account.capabilities, stateVersion: 7,
      } });
      for (const beneficiary of [...fixture.beneficiaries, ...expanded.beneficiaries]) {
        await tx.beneficiary.create({ data: { ...beneficiary, userId, status: "ACTIVE", version: 1 } });
      }
      await tx.asset.create({ data: fixture.asset });
      await tx.holding.create({ data: { userId, assetId: fixture.asset.id, quantity: "2", stateVersion: 7 } });
      for (const [entityType, entityId, alias] of [...fixture.aliases, ...expanded.aliases]) {
        await tx.entityAlias.create({ data: { id: aliasId(userId, entityType, entityId, alias), userId, entityType, entityId, alias } });
      }
    }, { isolationLevel: "Serializable", timeout: 30000 });
    console.log("ISOLATED_SYNTHETIC_SEED_COMPLETE: one customer, two accounts, one holding, synthetic payees, and one external identity");
  }
} finally {
  await db.$disconnect();
}
