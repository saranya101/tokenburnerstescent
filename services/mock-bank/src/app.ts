import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import Fastify from "fastify";
import { AssetQuoteV1, AssetV1, BankStateSnapshotV1, FxQuoteV1, MoneyV1, type AssetQuoteV1 as AssetQuote } from "@parlance/contracts";
import { z } from "zod";
import { logger, resolveTraceId } from "@parlance/observability";

type Scenario = "FX_UNAVAILABLE" | "TRANSFER_RAIL_UNAVAILABLE" | "ASSET_UNAVAILABLE" | "BALANCE_CHANGED" | "QUOTE_EXPIRED";
type Asset = z.infer<typeof AssetV1>;
type FxQuote = z.infer<typeof FxQuoteV1>;
type IssuedFxQuote = { quote: FxQuote; amount?: z.infer<typeof MoneyV1> };
interface State {
  stateVersion: number;
  balances: Record<string, bigint>;
  holdings: Record<string, string>;
  assets: Asset[];
  assetQuotes: AssetQuote[];
  fxQuotes: Map<string, IssuedFxQuote>;
  expiredFxQuoteIds: Set<string>;
  nextFxQuoteSequence: number;
  scenarios: Set<Scenario>;
}
interface StoredResponse { operation: "fx" | "transfer" | "payment" | "buy"; requestHash: string; response: { accepted: true; bankReference: string; stateVersion: number } }
export interface MockBankWriteRecord { operation: StoredResponse["operation"]; idempotencyKey: string; requestHash: string; response: StoredResponse["response"] }
export interface MockBankOptions {
  afterWrite?: (record: MockBankWriteRecord) => void;
  adminAuthorization?: { demoMode: boolean; opsToken?: string; demoUserId?: string };
  bankApiToken?: string;
  initialState?: { stateVersion: number; balances: Record<string, bigint>; holdings: Record<string, string> };
  beneficiaryDefinitions?: readonly BeneficiaryDefinition[];
  now?: () => Date;
  customerSnapshot?: (userId: string) => Promise<z.infer<typeof BankStateSnapshotV1>>;
}

const DEFAULT_INITIAL_STATE_VERSION = 7;
const DEFAULT_INITIAL_BALANCES = { "acc-sgd": 2_000_000n, "acc-usd": 500_000n };

const Id = z.string().min(1);
const FxBody = z.object({ userId: Id, accountId: Id, fromAmount: MoneyV1, toCurrency: z.string().length(3), quoteId: Id }).strict();
const TransferBody = z.union([z.object({ userId: Id, sourceAccountId: Id, beneficiaryId: Id, amount: MoneyV1 }).strict(), z.object({ userId: Id, sourceAccountId: Id, destinationAccountId: Id, amount: MoneyV1 }).strict()]);
const PaymentBody = z.object({ userId: Id, sourceAccountId: Id, obligationId: Id, amount: MoneyV1 }).strict();
const BuyBody = z.object({
  userId: Id, sourceAccountId: Id, assetId: Id, quantity: z.string(), maximumSpend: MoneyV1,
  quoteId: Id, settlementCurrency: z.string().regex(/^[A-Z]{3}$/), quotedUnitPriceMinor: z.string().regex(/^(0|[1-9]\d*)$/),
  quotedFeeMinor: z.string().regex(/^(0|[1-9]\d*)$/), authorizedTotalMinor: z.string().regex(/^(0|[1-9]\d*)$/),
}).strict();
type WriteBody = z.infer<typeof FxBody> | z.infer<typeof TransferBody> | z.infer<typeof PaymentBody> | z.infer<typeof BuyBody>;
const QuoteBody = z.object({ userId: Id, fromCurrency: z.string().length(3), toCurrency: z.string().length(3), amount: MoneyV1 }).strict();
// Definition order is the mock bank's deterministic first-account FX destination rule and snapshot order.
const ACCOUNT_DEFINITIONS = [
  { id: "acc-sgd", type: "CHECKING" as const, currency: "SGD", capabilities: ["SEND_TRANSFER", "RECEIVE_TRANSFER", "CONVERT_FX", "PAY_BILL", "TRADE_ASSET"] as const },
  { id: "acc-usd", type: "CHECKING" as const, currency: "USD", capabilities: ["SEND_TRANSFER", "RECEIVE_TRANSFER", "CONVERT_FX", "TRADE_ASSET"] as const },
];
type BeneficiaryDefinition = { id: string; name: string; supportedCurrencies: string[]; status: "ACTIVE" };
const BASE_BENEFICIARY_DEFINITIONS: BeneficiaryDefinition[] = [
  { id: "ben-ntu", name: "Nanyang Technological University", supportedCurrencies: ["USD"], status: "ACTIVE" as const },
  { id: "ben-john-tan", name: "John Tan", supportedCurrencies: ["SGD"], status: "ACTIVE" as const },
  { id: "ben-john-lim", name: "John Lim", supportedCurrencies: ["SGD"], status: "ACTIVE" as const },
];
const syntheticFixture = z.object({ beneficiaries: z.array(z.object({
  id: z.string().min(1), providerRef: z.string().min(1), name: z.string().min(1),
  supportedCurrencies: z.array(z.enum(["SGD", "USD"])).min(1),
}).strict()) }).parse(JSON.parse(readFileSync(new URL("../../../packages/db/prisma/synthetic-payees-v2.json", import.meta.url), "utf8")));

export function resolveBeneficiaryDefinitions(environment: NodeJS.ProcessEnv = process.env): BeneficiaryDefinition[] {
  if (environment.PARLANCE_LOCAL_TEST_MODE !== "true" || environment.PARLANCE_SYNTHETIC_PAYEES_V2 !== "true") return BASE_BENEFICIARY_DEFINITIONS;
  return [...BASE_BENEFICIARY_DEFINITIONS, ...syntheticFixture.beneficiaries.map((item) => ({
    id: item.id, name: item.name, supportedCurrencies: item.supportedCurrencies, status: "ACTIVE" as const,
  }))];
}
const ASSET_DEFINITIONS = [{ id: "asset-aapl", symbol: "AAPL", name: "Apple Inc.", assetType: "EQUITY" as const, tradable: true, settlementCurrency: "USD" }];
const DEMO_ASSET_QUOTE = AssetQuoteV1.parse({
  quoteId: "asset-quote-aapl-usd-v1", assetId: "asset-aapl", settlementCurrency: "USD",
  unitPriceMinor: "20000", feeMinor: "100", expiresAt: "2099-01-01T00:00:00.000Z",
});
const fxDestinationAccountId = (currency: string): string | undefined => ACCOUNT_DEFINITIONS.find((account) => account.currency === currency)?.id;
const initialState = (stateVersion: number): State => ({
  stateVersion,
  balances: { ...DEFAULT_INITIAL_BALANCES },
  holdings: {},
  assets: ASSET_DEFINITIONS.map((asset) => ({ ...asset })),
  assetQuotes: [{ ...DEMO_ASSET_QUOTE }],
  fxQuotes: new Map(),
  expiredFxQuoteIds: new Set(),
  nextFxQuoteSequence: 0,
  scenarios: new Set(),
});
const normalize = (value: unknown): unknown => Array.isArray(value) ? value.map(normalize) : value !== null && typeof value === "object"
  ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, normalize(item)]))
  : value;
const requestHash = (value: unknown): string => createHash("sha256").update(JSON.stringify(normalize(value))).digest("hex");
const addDecimalStrings = (left: string, right: string): string => {
  const parts = (value: string) => { const [integer, fraction = ""] = value.split("."); return { numerator: BigInt(`${integer}${fraction}`), scale: fraction.length }; };
  const a = parts(left); const b = parts(right); const scale = Math.max(a.scale, b.scale);
  const sum = a.numerator * 10n ** BigInt(scale - a.scale) + b.numerator * 10n ** BigInt(scale - b.scale);
  if (scale === 0) return sum.toString();
  const digits = sum.toString().padStart(scale + 1, "0"); const integer = digits.slice(0, -scale); const fraction = digits.slice(-scale).replace(/0+$/, "");
  return fraction ? `${integer}.${fraction}` : integer;
};
const multiplyRateHalfEven = (minorUnits: string, numerator: bigint, denominator: bigint): bigint => {
  const product = BigInt(minorUnits) * numerator; const quotient = product / denominator; const remainder = product % denominator; const doubled = remainder * 2n;
  return doubled > denominator || (doubled === denominator && quotient % 2n !== 0n) ? quotient + 1n : quotient;
};
const decimalRate = (rate: string): { numerator: bigint; denominator: bigint } => {
  const match = /^(0|[1-9]\d*)(?:\.(\d+))?$/u.exec(rate);
  if (!match) throw new Error("FX_QUOTE_RATE_INVALID");
  const fraction = match[2] ?? "";
  const numerator = BigInt(`${match[1]}${fraction}`);
  if (numerator <= 0n) throw new Error("FX_QUOTE_RATE_INVALID");
  return { numerator, denominator: 10n ** BigInt(fraction.length) };
};
const positiveQuantity = (quantity: string): { numerator: bigint; scale: bigint } => {
  const match = /^(0|[1-9]\d*)(?:\.(\d+))?$/.exec(quantity);
  if (!match) throw new Error("QUANTITY_INVALID");
  const fraction = match[2] ?? ""; const numerator = BigInt(`${match[1]}${fraction}`);
  if (numerator <= 0n) throw new Error("QUANTITY_INVALID");
  return { numerator, scale: 10n ** BigInt(fraction.length) };
};
const authoritativeAssetTotal = (quantity: string, unitPriceMinor: string, feeMinor: string): bigint => {
  const parsed = positiveQuantity(quantity); const product = parsed.numerator * BigInt(unitPriceMinor);
  if (product % parsed.scale !== 0n) throw new Error("QUANTITY_INVALID");
  return product / parsed.scale + BigInt(feeMinor);
};

export function buildApp(options: MockBankOptions = {}) {
  const states = new Map<string, State>(); const idempotency = new Map<string, StoredResponse>();
  const configuredInitialState = options.initialState ?? resolveInitialStateConfiguration();
  const beneficiaryDefinitions = options.beneficiaryDefinitions ?? resolveBeneficiaryDefinitions();
  const now = options.now ?? (() => new Date());
  const getState = (userId: string): State => {
    const existing = states.get(userId); if (existing) return existing;
    const created = initialState(configuredInitialState.stateVersion); created.balances = { ...configuredInitialState.balances }; created.holdings = { ...configuredInitialState.holdings }; states.set(userId, created); return created;
  };
  const pruneFxQuotes = (state: State): void => {
    const currentTime = now().getTime();
    for (const [id, issued] of state.fxQuotes) {
      if (Date.parse(issued.quote.expiresAt) <= currentTime) {
        state.fxQuotes.delete(id);
        state.expiredFxQuoteIds.add(id);
      }
    }
  };
  const issueFxQuote = (userId: string, state: State, fromCurrency: string, toCurrency: string, amount?: z.infer<typeof MoneyV1>): IssuedFxQuote => {
    pruneFxQuotes(state);
    const existing = [...state.fxQuotes.values()].find((issued) => issued.quote.fromCurrency === fromCurrency
      && issued.quote.toCurrency === toCurrency
      && (amount === undefined
        ? issued.amount === undefined
        : issued.amount?.currency === amount.currency && issued.amount.minorUnits === amount.minorUnits));
    if (existing) return existing;
    const issued: IssuedFxQuote = {
      quote: FxQuoteV1.parse({
        id: `q-${userId}-${state.stateVersion}-${++state.nextFxQuoteSequence}`,
        fromCurrency,
        toCurrency,
        rate: "0.75",
        expiresAt: new Date(now().getTime() + 60_000).toISOString(),
      }),
      ...(amount === undefined ? {} : { amount: { ...amount } }),
    };
    state.fxQuotes.set(issued.quote.id, issued);
    return issued;
  };
  const activeFxQuotes = (userId: string, state: State): FxQuote[] => {
    pruneFxQuotes(state);
    issueFxQuote(userId, state, "SGD", "USD");
    return [...state.fxQuotes.values()].map(({ quote }) => ({ ...quote, ...(quote.fee ? { fee: { ...quote.fee } } : {}) }));
  };
  const app = Fastify({ loggerInstance: logger });
  const securityConfiguration = () => {
    const authorization = options.adminAuthorization ?? { demoMode: process.env.PARLANCE_DEMO_MODE === "true", opsToken: process.env.PARLANCE_OPS_API_TOKEN, demoUserId: process.env.PARLANCE_DEMO_USER_ID };
    const bankToken = options.bankApiToken?.trim() || process.env.PARLANCE_BANK_API_TOKEN?.trim();
    const opsToken = authorization.opsToken?.trim(); const demoUserId = authorization.demoUserId?.trim();
    const separated = !bankToken || !opsToken || !safeSecretEqual(bankToken, opsToken);
    const ready = Boolean(bankToken && separated && (!authorization.demoMode || (opsToken && demoUserId)));
    return { authorization, bankToken, opsToken, ready, separated };
  };
  app.addHook("onRequest", async (request, reply) => { const traceId = resolveTraceId(request.headers["x-trace-id"]); request.headers["x-trace-id"] = traceId; reply.header("x-trace-id", traceId); });
  app.addHook("preHandler", async (request, reply) => {
    const security = securityConfiguration();
    const routeUrl = request.routeOptions.url ?? "";
    if (routeUrl.startsWith("/v1/admin/")) {
      const authorization = security.authorization;
      if (!authorization.demoMode) return reply.code(404).send({ code: "NOT_FOUND" });
      const supplied = typeof request.headers["x-parlance-ops-token"] === "string" ? request.headers["x-parlance-ops-token"] : undefined;
      if (!security.ready || !security.opsToken || !supplied || !safeSecretEqual(supplied, security.opsToken)) return reply.code(401).send({ code: "UNAUTHORIZED" });
      const target = typeof request.params === "object" && request.params !== null && "userId" in request.params ? request.params.userId : undefined;
      if (typeof target !== "string" || target !== authorization.demoUserId?.trim()) return reply.code(404).send({ code: "NOT_FOUND" });
      return;
    }
    if (!routeUrl.startsWith("/v1/")) return;
    const expected = security.bankToken;
    const supplied = typeof request.headers["x-parlance-bank-token"] === "string" ? request.headers["x-parlance-bank-token"] : undefined;
    if (!security.ready || !expected || !supplied || !safeSecretEqual(supplied, expected)) return reply.code(401).send({ code: "UNAUTHORIZED" });
  });
  app.get("/health", async () => ({ status: "ok", service: "mock-bank" }));
  app.get("/ready", async (_request, reply) => securityConfiguration().ready ? { status: "ready" } : reply.code(503).send({ status: "not_ready" }));
  app.get("/v1/service/ready", async () => ({ status: "ready" }));
  app.get("/v1/executions/idempotency/:key", async (request, reply) => {
    // A PostgreSQL customer snapshot has no durable bank-operation ledger yet.
    // An in-memory NOT_FOUND would falsely authorize a retry after a restart.
    if (options.customerSnapshot) return reply.code(503).send({ code: "BANK_LOOKUP_UNAVAILABLE" });
    const { key } = z.object({ key: Id }).parse(request.params); const prior = idempotency.get(key);
    return prior ? { status: "COMPLETED" as const, idempotencyKey: key, operation: prior.operation, requestHash: prior.requestHash, ...prior.response } : { status: "NOT_FOUND" as const, idempotencyKey: key };
  });
  app.get("/v1/state/:userId", async (request) => { const { userId } = z.object({ userId: Id }).parse(request.params); if (options.customerSnapshot) return options.customerSnapshot(userId); const state = getState(userId); return BankStateSnapshotV1.parse({
    schemaVersion: "1", userId, stateVersion: state.stateVersion, capturedAt: new Date().toISOString(),
    accounts: ACCOUNT_DEFINITIONS.map((account) => ({ ...account, capabilities: [...account.capabilities], ledgerMinorUnits: state.balances[account.id]!.toString(), availableMinorUnits: state.balances[account.id]!.toString(), status: "ACTIVE" as const })), beneficiaries: beneficiaryDefinitions.map((beneficiary) => ({ ...beneficiary, supportedCurrencies: [...beneficiary.supportedCurrencies] })), assets: state.assets,
    holdings: Object.entries(state.holdings).map(([assetId, quantity]) => ({ assetId, quantity })), obligations: [], serviceAvailability: { transfers: !state.scenarios.has("TRANSFER_RAIL_UNAVAILABLE"), fx: !state.scenarios.has("FX_UNAVAILABLE"), billPayments: !state.scenarios.has("TRANSFER_RAIL_UNAVAILABLE"), investments: !state.scenarios.has("ASSET_UNAVAILABLE") },
    fxQuotes: activeFxQuotes(userId, state), assetQuotes: state.assetQuotes,
  }); });
  app.post("/v1/fx/quote", async (request, reply) => { const body = QuoteBody.parse(request.body); const state = getState(body.userId); if (state.scenarios.has("FX_UNAVAILABLE")) return reply.code(503).send({ code: "FX_UNAVAILABLE" }); return issueFxQuote(body.userId, state, body.fromCurrency, body.toCurrency, body.amount).quote; });
  const debit = (state: State, accountId: string, money: { minorUnits: string }): void => { const balance = state.balances[accountId]; if (balance === undefined) throw new Error("ACCOUNT_NOT_FOUND"); const amount = BigInt(money.minorUnits); if (balance < amount) throw new Error("INSUFFICIENT_FUNDS"); state.balances[accountId] = balance - amount; };
  const requireAccountCurrency = (accountId: string, currency: string): void => {
    const account = ACCOUNT_DEFINITIONS.find((candidate) => candidate.id === accountId);
    if (!account) throw new Error("ACCOUNT_NOT_FOUND");
    if (account.currency !== currency) throw new Error("ACCOUNT_CURRENCY_MISMATCH");
  };
  const execute = <T extends WriteBody>(path: "fx" | "transfer" | "payment" | "buy", schema: z.ZodType<T>, blocked: Scenario, mutate: (state: State, body: T) => void) => app.post(`/v1/execute/${path}`, async (request, reply) => {
    if (options.customerSnapshot) return reply.code(403).send({ code: "BANK_EXECUTION_DISABLED" });
    const key = request.headers["idempotency-key"]; if (typeof key !== "string" || !key) return reply.code(400).send({ code: "IDEMPOTENCY_KEY_REQUIRED" });
    const body = schema.parse(request.body); const hash = requestHash(body); const prior = idempotency.get(key); if (prior) return prior.operation === path && prior.requestHash === hash ? prior.response : reply.code(409).send({ code: "IDEMPOTENCY_KEY_REUSED" });
    const state = getState(body.userId); if (state.scenarios.has(blocked)) return reply.code(503).send({ code: blocked }); if (path === "fx" && state.scenarios.has("QUOTE_EXPIRED")) return reply.code(409).send({ code: "QUOTE_EXPIRED" }); if (state.scenarios.has("BALANCE_CHANGED")) return reply.code(409).send({ code: "BALANCE_CHANGED", stateVersion: state.stateVersion });
    try { mutate(state, body); } catch (error) { return reply.code(409).send({ code: error instanceof Error ? error.message : "WRITE_REJECTED" }); }
    state.stateVersion += 1; const response = { accepted: true as const, bankReference: `mock-${key}`, stateVersion: state.stateVersion }; const record = { operation: path, idempotencyKey: key, requestHash: hash, response }; idempotency.set(key, { operation: path, requestHash: hash, response }); options.afterWrite?.(record); return response;
  });
  execute("fx", FxBody, "FX_UNAVAILABLE", (state, body) => {
    pruneFxQuotes(state);
    const issued = state.fxQuotes.get(body.quoteId);
    if (!issued) throw new Error(state.expiredFxQuoteIds.has(body.quoteId) ? "QUOTE_EXPIRED" : "FX_QUOTE_NOT_FOUND");
    if (issued.quote.fromCurrency !== body.fromAmount.currency || issued.quote.toCurrency !== body.toCurrency) throw new Error("FX_QUOTE_CURRENCY_MISMATCH");
    if (issued.amount && (issued.amount.currency !== body.fromAmount.currency || issued.amount.minorUnits !== body.fromAmount.minorUnits)) throw new Error("FX_QUOTE_AMOUNT_MISMATCH");
    requireAccountCurrency(body.accountId, body.fromAmount.currency);
    const target = fxDestinationAccountId(body.toCurrency); if (!target) throw new Error("FX_DESTINATION_ACCOUNT_NOT_FOUND");
    const feeMinorUnits = issued.quote.fee?.minorUnits ?? "0";
    if (issued.quote.fee && issued.quote.fee.currency !== body.fromAmount.currency) throw new Error("FX_QUOTE_FEE_CURRENCY_MISMATCH");
    debit(state, body.accountId, { minorUnits: (BigInt(body.fromAmount.minorUnits) + BigInt(feeMinorUnits)).toString() });
    const rate = decimalRate(issued.quote.rate);
    state.balances[target] = (state.balances[target] ?? 0n) + multiplyRateHalfEven(body.fromAmount.minorUnits, rate.numerator, rate.denominator);
  });
  execute("transfer", TransferBody, "TRANSFER_RAIL_UNAVAILABLE", (state, body) => {
    requireAccountCurrency(body.sourceAccountId, body.amount.currency);
    if ("beneficiaryId" in body) {
      const beneficiary = beneficiaryDefinitions.find((candidate) => candidate.id === body.beneficiaryId);
      if (!beneficiary) throw new Error("BENEFICIARY_NOT_FOUND");
      if (beneficiary.status !== "ACTIVE") throw new Error("BENEFICIARY_UNAVAILABLE");
      if (!beneficiary.supportedCurrencies.some((currency) => currency === body.amount.currency)) throw new Error("BENEFICIARY_CURRENCY_UNSUPPORTED");
    } else {
      requireAccountCurrency(body.destinationAccountId, body.amount.currency);
    }
    debit(state, body.sourceAccountId, body.amount);
    if ("destinationAccountId" in body) state.balances[body.destinationAccountId] = (state.balances[body.destinationAccountId] ?? 0n) + BigInt(body.amount.minorUnits);
  });
  execute("payment", PaymentBody, "TRANSFER_RAIL_UNAVAILABLE", (state, body) => debit(state, body.sourceAccountId, body.amount)); execute("buy", BuyBody, "ASSET_UNAVAILABLE", (state, body) => {
    const quote = state.assetQuotes.find((item) => item.quoteId === body.quoteId); if (!quote) throw new Error("ASSET_QUOTE_NOT_FOUND");
    if (quote.assetId !== body.assetId) throw new Error("ASSET_QUOTE_ASSET_MISMATCH");
    const asset = state.assets.find((item) => item.id === body.assetId); if (!asset?.tradable) throw new Error("ASSET_NOT_TRADABLE");
    if (quote.settlementCurrency !== body.settlementCurrency || asset.settlementCurrency !== body.settlementCurrency) throw new Error("ASSET_QUOTE_SETTLEMENT_CURRENCY_MISMATCH");
    const account = ACCOUNT_DEFINITIONS.find((item) => item.id === body.sourceAccountId); if (!account || account.currency !== body.settlementCurrency) throw new Error("SOURCE_ACCOUNT_CURRENCY_MISMATCH");
    if (Date.parse(quote.expiresAt) <= now().getTime()) throw new Error("ASSET_QUOTE_EXPIRED");
    if (body.quotedUnitPriceMinor !== quote.unitPriceMinor) throw new Error("ASSET_QUOTE_UNIT_PRICE_MISMATCH");
    if (body.quotedFeeMinor !== quote.feeMinor) throw new Error("ASSET_QUOTE_FEE_MISMATCH");
    const total = authoritativeAssetTotal(body.quantity, quote.unitPriceMinor, quote.feeMinor);
    if (BigInt(body.authorizedTotalMinor) !== total) throw new Error("AUTHORIZED_TOTAL_MISMATCH");
    if (body.maximumSpend.currency !== body.settlementCurrency) throw new Error("MAXIMUM_SPEND_CURRENCY_MISMATCH");
    if (BigInt(body.maximumSpend.minorUnits) < 0n || total > BigInt(body.maximumSpend.minorUnits)) throw new Error("MAXIMUM_SPEND_EXCEEDED");
    debit(state, body.sourceAccountId, { minorUnits: body.authorizedTotalMinor });
    state.holdings[body.assetId] = addDecimalStrings(state.holdings[body.assetId] ?? "0", body.quantity);
  });
  app.get("/v1/admin/scenarios/:userId", async (request) => { const { userId } = z.object({ userId: Id }).parse(request.params); return { scenarios: [...getState(userId).scenarios] }; });
  app.post("/v1/admin/scenarios/:userId", async (request) => { const { userId } = z.object({ userId: Id }).parse(request.params); const body = z.object({ scenarios: z.array(z.enum(["FX_UNAVAILABLE", "TRANSFER_RAIL_UNAVAILABLE", "ASSET_UNAVAILABLE", "BALANCE_CHANGED", "QUOTE_EXPIRED"])) }).parse(request.body); const state = getState(userId); state.scenarios = new Set(body.scenarios); return { scenarios: [...state.scenarios] }; });
  app.put("/v1/admin/asset-quotes/:userId", async (request) => { const { userId } = z.object({ userId: Id }).parse(request.params); const body = z.object({ assetQuotes: z.array(AssetQuoteV1) }).strict().parse(request.body); const state = getState(userId); state.assetQuotes = body.assetQuotes; return { assetQuotes: state.assetQuotes }; });
  app.put("/v1/admin/assets/:userId", async (request) => { const { userId } = z.object({ userId: Id }).parse(request.params); const body = z.object({ assets: z.array(AssetV1) }).strict().parse(request.body); const state = getState(userId); state.assets = body.assets; return { assets: state.assets }; });
  return app;
}

export function resolveInitialStateConfiguration(environment: NodeJS.ProcessEnv = process.env): { stateVersion: number; balances: Record<string, bigint>; holdings: Record<string, string> } {
  const configured = environment.PARLANCE_MOCK_BANK_INITIAL_STATE_VERSION?.trim();
  const configuredBalances = environment.PARLANCE_MOCK_BANK_INITIAL_BALANCES?.trim();
  const configuredHoldings = environment.PARLANCE_MOCK_BANK_INITIAL_HOLDINGS?.trim();
  if (!configured && !configuredBalances && !configuredHoldings) return { stateVersion: DEFAULT_INITIAL_STATE_VERSION, balances: { ...DEFAULT_INITIAL_BALANCES }, holdings: {} };
  if (environment.NODE_ENV === "production" || environment.PARLANCE_LOCAL_TEST_MODE !== "true") {
    throw new Error("MOCK_BANK_INITIAL_STATE_VERSION_OVERRIDE_FORBIDDEN");
  }
  if (!configured || !/^[1-9]\d*$/u.test(configured)) throw new Error("MOCK_BANK_INITIAL_STATE_VERSION_INVALID");
  const version = Number(configured);
  if (!Number.isSafeInteger(version)) throw new Error("MOCK_BANK_INITIAL_STATE_VERSION_INVALID");
  if (!configuredBalances) throw new Error("MOCK_BANK_INITIAL_BALANCES_REQUIRED");
  if (!configuredHoldings) throw new Error("MOCK_BANK_INITIAL_HOLDINGS_REQUIRED");
  let parsedBalances: unknown; let parsedHoldings: unknown;
  try { parsedBalances = JSON.parse(configuredBalances); } catch { throw new Error("MOCK_BANK_INITIAL_BALANCES_INVALID"); }
  try { parsedHoldings = JSON.parse(configuredHoldings); } catch { throw new Error("MOCK_BANK_INITIAL_HOLDINGS_INVALID"); }
  const balances = z.object({ "acc-sgd": z.string().regex(/^(0|[1-9]\d*)$/), "acc-usd": z.string().regex(/^(0|[1-9]\d*)$/) }).strict().safeParse(parsedBalances);
  if (!balances.success) throw new Error("MOCK_BANK_INITIAL_BALANCES_INVALID");
  const holdings = z.object({ "asset-aapl": z.string().regex(/^(0|[1-9]\d*)(?:\.\d+)?$/).optional() }).strict().safeParse(parsedHoldings);
  if (!holdings.success) throw new Error("MOCK_BANK_INITIAL_HOLDINGS_INVALID");
  const restoredHoldings = Object.fromEntries(Object.entries(holdings.data).filter((entry): entry is [string, string] => entry[1] !== undefined));
  return { stateVersion: version, balances: Object.fromEntries(Object.entries(balances.data).map(([id, value]) => [id, BigInt(value)])), holdings: restoredHoldings };
}

function safeSecretEqual(left: string, right: string): boolean {
  return timingSafeEqual(createHash("sha256").update(left).digest(), createHash("sha256").update(right).digest());
}
