import { randomUUID } from "node:crypto";
import { AssetV1, BankStateSnapshotV1, FxQuoteV1, MoneyV1 } from "@parlance/contracts";
import { getPrismaClient, Prisma, type PrismaClient } from "@parlance/db";
import { z } from "zod";
import type { DurableBank, State, StoredResponse } from "./app.js";

const Response = z.object({ accepted: z.literal(true), bankReference: z.string().min(1), stateVersion: z.number().int().nonnegative() }).strict();
type Path = StoredResponse["operation"];
type WriteResult = StoredResponse["response"];
const ASSET_QUOTE_TTL_MS = 5 * 60_000;
const FX_QUOTE_TTL_MS = 60_000;

class BankRejection extends Error {
  constructor(message: string, readonly statusCode = 409) { super(message); }
}

function customerTargetIsolated(environment: NodeJS.ProcessEnv = process.env): boolean {
  const url = environment.DATABASE_URL;
  if (!url) return false;
  let parsed: URL;
  try { parsed = new URL(url); } catch { return false; }
  if (!/^postgres(?:ql)?:$/u.test(parsed.protocol)) return false;
  const direct = environment.DIRECT_URL;
  if (!direct) return false;
  let directParsed: URL;
  try { directParsed = new URL(direct); } catch { return false; }
  if (directParsed.protocol !== parsed.protocol || directParsed.hostname !== parsed.hostname || directParsed.port !== parsed.port || directParsed.pathname !== parsed.pathname || directParsed.username !== parsed.username || directParsed.password !== parsed.password) return false;
  if (environment.PARLANCE_LOCAL_TEST_MODE === "true" && environment.NODE_ENV !== "production") {
    return ["localhost", "127.0.0.1"].includes(parsed.hostname) && /^\/parlance_test_[a-z0-9_]+$/u.test(parsed.pathname);
  }
  return environment.RAILWAY_PROJECT_ID === "55d5cb65-c1ce-4431-877c-63d08969713e" &&
    environment.RAILWAY_ENVIRONMENT_ID === "17977510-a832-4949-b083-e24e4b36c7c6" &&
    environment.RAILWAY_SERVICE_ID === "1ff8b7d4-ab42-4edb-a0b8-988291c8c9ad" &&
    parsed.hostname === "postgres.railway.internal" && (!parsed.port || parsed.port === "5432") && parsed.pathname === "/railway";
}

export function durableBankEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
  if (environment.PARLANCE_BANK_DURABLE_EXECUTION !== "true") return false;
  if (environment.PARLANCE_ISOLATED_SYNTHETIC_EXECUTION_APPROVED !== "true" || !customerTargetIsolated(environment)) {
    throw new Error("DURABLE_BANK_TARGET_NOT_APPROVED");
  }
  return true;
}

type Transaction = Prisma.TransactionClient;
async function lockedState(tx: Transaction, userId: string) {
  // PostgreSQL 15+ records the database-default collation version. If the
  // underlying OS collation changed, text indexes may no longer be reliable;
  // financial writes must wait for an approved REINDEX and version refresh.
  const versions = await tx.$queryRaw<Array<{ version: number }>>`SELECT current_setting('server_version_num')::integer AS version`;
  if (versions.length !== 1) throw new BankRejection("BANK_COLLATION_STATUS_UNAVAILABLE", 503);
  if (versions[0]!.version >= 150000) {
    const collations = await tx.$queryRaw<Array<{ healthy: boolean }>>`
      SELECT datcollversion IS NOT DISTINCT FROM pg_database_collation_actual_version(oid) AS healthy
      FROM pg_database WHERE datname = current_database()`;
    if (collations.length !== 1 || !collations[0]!.healthy) throw new BankRejection("BANK_COLLATION_MISMATCH", 503);
  }
  const users = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
  if (users.length !== 1) throw new BankRejection("CUSTOMER_NOT_FOUND", 404);
  const existing = await tx.bankServiceState.findUnique({ where: { userId } });
  if (existing) return existing;
  const [accounts, holdings] = await Promise.all([
    tx.account.findMany({ where: { userId, status: "ACTIVE" }, select: { stateVersion: true } }),
    tx.holding.findMany({ where: { userId }, select: { stateVersion: true } }),
  ]);
  if (accounts.length !== 2) throw new BankRejection("SYNTHETIC_ACCOUNT_SET_INVALID", 503);
  return tx.bankServiceState.create({ data: {
    userId, stateVersion: Math.max(0, ...accounts.map((item) => item.stateVersion), ...holdings.map((item) => item.stateVersion)),
    transfers: true, fx: true, billPayments: false, investments: true,
  } });
}

function fxQuote(row: { providerRef: string; fromCurrency: string; toCurrency: string; rate: Prisma.Decimal; feeCurrency: string | null; feeMinorUnits: bigint | null; expiresAt: Date }) {
  return FxQuoteV1.parse({
    id: row.providerRef, fromCurrency: row.fromCurrency, toCurrency: row.toCurrency,
    rate: row.rate.toString(), expiresAt: row.expiresAt.toISOString(),
    ...(row.feeCurrency && row.feeMinorUnits !== null ? { fee: { currency: row.feeCurrency, minorUnits: row.feeMinorUnits.toString() } } : {}),
  });
}

export class PrismaDurableBank implements DurableBank {
  constructor(private readonly db: PrismaClient = getPrismaClient(), private readonly now: () => Date = () => new Date(),
    private readonly beforeCommit?: () => void) {}

  async snapshot(userId: string): Promise<z.infer<typeof BankStateSnapshotV1>> {
    return this.db.$transaction(async (tx) => {
      const service = await lockedState(tx, userId);
      const now = this.now();
      const [accounts, beneficiaries, holdings, assets, fxRows] = await Promise.all([
        tx.account.findMany({ where: { userId, status: "ACTIVE" }, orderBy: { currency: "asc" } }),
        tx.beneficiary.findMany({ where: { userId, status: "ACTIVE" }, orderBy: { name: "asc" } }),
        tx.holding.findMany({ where: { userId }, orderBy: { assetId: "asc" } }),
        tx.asset.findMany({ where: { tradable: true }, orderBy: { symbol: "asc" } }),
        tx.fxQuote.findMany({ where: { userId, expiresAt: { gt: now } } }),
      ]);
      const apple = assets.find((item) => item.symbol === "AAPL");
      let assetQuote = apple ? await tx.syntheticAssetQuote.findFirst({ where: { userId, assetId: apple.id, expiresAt: { gt: now } }, orderBy: { createdAt: "desc" } }) : null;
      if (apple && !assetQuote) assetQuote = await tx.syntheticAssetQuote.create({ data: {
        id: randomUUID(), userId, assetId: apple.id, settlementCurrency: apple.settlementCurrency,
        unitPriceMinor: 20_000n, feeMinor: 100n, stateVersion: service.stateVersion,
        expiresAt: new Date(now.getTime() + ASSET_QUOTE_TTL_MS),
      } });
      return BankStateSnapshotV1.parse({
        schemaVersion: "1", userId, stateVersion: service.stateVersion, capturedAt: now.toISOString(),
        accounts: accounts.map((item) => ({ id: item.id, type: item.type, currency: item.currency,
          ledgerMinorUnits: item.ledgerMinorUnits.toString(), availableMinorUnits: item.availableMinorUnits.toString(),
          status: item.status, capabilities: item.capabilities })),
        beneficiaries: beneficiaries.map((item) => ({ id: item.id, name: item.name, supportedCurrencies: item.supportedCurrencies, status: item.status })),
        assets: assets.map((item) => ({ id: item.id, symbol: item.symbol, name: item.name, assetType: item.assetType,
          tradable: item.tradable, settlementCurrency: item.settlementCurrency })),
        holdings: holdings.map((item) => ({ assetId: item.assetId, quantity: item.quantity.toString() })),
        obligations: [],
        serviceAvailability: { transfers: service.transfers, fx: service.fx, billPayments: false, investments: service.investments },
        fxQuotes: fxRows.map(fxQuote),
        assetQuotes: assetQuote ? [{ quoteId: assetQuote.id, assetId: assetQuote.assetId,
          settlementCurrency: assetQuote.settlementCurrency, unitPriceMinor: assetQuote.unitPriceMinor.toString(),
          feeMinor: assetQuote.feeMinor.toString(), expiresAt: assetQuote.expiresAt.toISOString() }] : [],
      });
    }, { isolationLevel: "Serializable" });
  }

  async issueFxQuote(userId: string, fromCurrency: string, toCurrency: string, amount: z.infer<typeof MoneyV1>) {
    if (fromCurrency !== "SGD" || toCurrency !== "USD" || amount.currency !== fromCurrency || BigInt(amount.minorUnits) <= 0n) throw new BankRejection("FX_PAIR_UNAVAILABLE");
    return this.db.$transaction(async (tx) => {
      const service = await lockedState(tx, userId);
      if (!service.fx) throw new BankRejection("FX_UNAVAILABLE", 503);
      const now = this.now();
      const existing = await tx.fxQuote.findFirst({ where: { userId, fromCurrency, toCurrency,
        amountMinorUnits: BigInt(amount.minorUnits), expiresAt: { gt: now } }, orderBy: { quotedAt: "desc" } });
      if (existing) return fxQuote(existing);
      const created = await tx.fxQuote.create({ data: { userId, providerRef: `q-${randomUUID()}`, fromCurrency, toCurrency,
        rate: new Prisma.Decimal("0.75"), feeCurrency: null, feeMinorUnits: null,
        amountMinorUnits: BigInt(amount.minorUnits), stateVersion: service.stateVersion, quotedAt: now,
        expiresAt: new Date(now.getTime() + FX_QUOTE_TTL_MS) } });
      return fxQuote(created);
    }, { isolationLevel: "Serializable" });
  }

  async lookup(key: string): ReturnType<DurableBank["lookup"]> {
    const row = await this.db.syntheticBankOperation.findUnique({ where: { idempotencyKey: key } });
    if (!row) return { status: "NOT_FOUND", idempotencyKey: key };
    return { status: "COMPLETED", idempotencyKey: key, operation: row.operation as Path,
      requestHash: row.requestHash, ...Response.parse(row.response) };
  }

  async execute<T extends { userId: string }>(path: Path, body: T, key: string, hash: string, expectedVersion: number, mutate: (state: State, body: T) => void): Promise<WriteResult> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        return await this.db.$transaction(async (tx) => {
          const service = await lockedState(tx, body.userId);
          const prior = await tx.syntheticBankOperation.findUnique({ where: { idempotencyKey: key } });
          if (prior) {
            if (prior.userId !== body.userId || prior.operation !== path || prior.requestHash !== hash) throw new BankRejection("IDEMPOTENCY_KEY_REUSED");
            return Response.parse(prior.response);
          }
          if (service.stateVersion !== expectedVersion) throw new BankRejection("BALANCE_CHANGED");
          if (path === "payment" || path === "transfer" && !service.transfers || path === "fx" && !service.fx || path === "buy" && !service.investments) throw new BankRejection("BANK_OPERATION_UNAVAILABLE", 503);
          const now = this.now();
          if (path === "fx" && "quoteId" in body) {
            const quote = await tx.fxQuote.findUnique({ where: { providerRef: body.quoteId as string } });
            if (quote?.userId === body.userId && quote.expiresAt <= now) throw new BankRejection("QUOTE_EXPIRED");
          }
          if (path === "buy" && "quoteId" in body) {
            const quote = await tx.syntheticAssetQuote.findUnique({ where: { id: body.quoteId as string } });
            if (quote?.userId === body.userId && quote.expiresAt <= now) throw new BankRejection("ASSET_QUOTE_EXPIRED");
          }
          const [accounts, beneficiaries, holdings, assets, fxRows, quoteRows] = await Promise.all([
            tx.account.findMany({ where: { userId: body.userId, status: "ACTIVE" } }),
            tx.beneficiary.findMany({ where: { userId: body.userId, status: "ACTIVE" } }),
            tx.holding.findMany({ where: { userId: body.userId } }),
            tx.asset.findMany({ where: { tradable: true } }),
            tx.fxQuote.findMany({ where: { userId: body.userId, expiresAt: { gt: now } } }),
            tx.syntheticAssetQuote.findMany({ where: { userId: body.userId, expiresAt: { gt: now } } }),
          ]);
          if (accounts.length !== 2 || accounts.some((item) => item.stateVersion !== service.stateVersion)) throw new BankRejection("BANK_STATE_INCONSISTENT", 503);
          const state: State = {
            stateVersion: service.stateVersion,
            accountCurrencies: Object.fromEntries(accounts.map((item) => [item.id, item.currency])),
            balances: Object.fromEntries(accounts.map((item) => [item.id, item.availableMinorUnits])),
            holdings: Object.fromEntries(holdings.map((item) => [item.assetId, item.quantity.toString()])),
            assets: assets.map((item) => AssetV1.parse({ id: item.id, symbol: item.symbol, name: item.name, assetType: item.assetType,
              tradable: item.tradable, settlementCurrency: item.settlementCurrency })),
            beneficiaries: beneficiaries.map((item) => ({ id: item.id, name: item.name, supportedCurrencies: item.supportedCurrencies as string[], status: "ACTIVE" })),
            assetQuotes: quoteRows.map((item) => ({ quoteId: item.id, assetId: item.assetId, settlementCurrency: item.settlementCurrency,
              unitPriceMinor: item.unitPriceMinor.toString(), feeMinor: item.feeMinor.toString(), expiresAt: item.expiresAt.toISOString() })),
            fxQuotes: new Map(fxRows.map((item) => [item.providerRef, { quote: fxQuote(item),
              ...(item.amountMinorUnits === null ? {} : { amount: { currency: item.fromCurrency, minorUnits: item.amountMinorUnits.toString() } }) }])),
            expiredFxQuoteIds: new Set(), nextFxQuoteSequence: 0, scenarios: new Set(),
          };
          try { mutate(state, body); }
          catch (error) { throw new BankRejection(error instanceof Error ? error.message : "WRITE_REJECTED"); }
          const next = service.stateVersion + 1;
          if (!Number.isSafeInteger(next)) throw new BankRejection("BANK_STATE_VERSION_EXHAUSTED", 503);
          for (const account of accounts) {
            const balance = state.balances[account.id];
            if (balance === undefined || balance < 0n) throw new BankRejection("BANK_STATE_INVALID", 503);
            await tx.account.update({ where: { id: account.id }, data: { availableMinorUnits: balance, ledgerMinorUnits: balance, stateVersion: next } });
          }
          for (const [assetId, quantity] of Object.entries(state.holdings)) {
            const priorHolding = holdings.find((item) => item.assetId === assetId);
            if (priorHolding?.quantity.toString() === quantity) continue;
            await tx.holding.upsert({ where: { userId_assetId: { userId: body.userId, assetId } },
              create: { userId: body.userId, assetId, quantity: new Prisma.Decimal(quantity), stateVersion: next },
              update: { quantity: new Prisma.Decimal(quantity), stateVersion: next } });
          }
          await tx.bankServiceState.update({ where: { userId: body.userId }, data: { stateVersion: next } });
          const response = { accepted: true as const, bankReference: `mock-${key}`, stateVersion: next };
          this.beforeCommit?.();
          await tx.syntheticBankOperation.create({ data: { idempotencyKey: key, userId: body.userId, operation: path,
            requestHash: hash, bankReference: response.bankReference, stateVersion: next, response } });
          return response;
        }, { isolationLevel: "Serializable", timeout: 15_000 });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034" && attempt < 3) continue;
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") throw new BankRejection("IDEMPOTENCY_KEY_REUSED");
        throw error;
      }
    }
    throw new BankRejection("BANK_OUTCOME_UNKNOWN", 503);
  }
}
