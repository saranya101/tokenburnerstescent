import { createHash } from "node:crypto";
import Fastify from "fastify";
import { AssetQuoteV1, AssetV1, BankStateSnapshotV1, MoneyV1, type AssetQuoteV1 as AssetQuote } from "@parlance/contracts";
import { z } from "zod";
import { logger, resolveTraceId } from "@parlance/observability";

type Scenario = "FX_UNAVAILABLE" | "TRANSFER_RAIL_UNAVAILABLE" | "ASSET_UNAVAILABLE" | "BALANCE_CHANGED" | "QUOTE_EXPIRED";
type Asset = z.infer<typeof AssetV1>;
interface State { stateVersion: number; balances: Record<string, bigint>; holdings: Record<string, string>; assets: Asset[]; assetQuotes: AssetQuote[]; scenarios: Set<Scenario> }
interface StoredResponse { operation: "fx" | "transfer" | "payment" | "buy"; requestHash: string; response: { accepted: true; bankReference: string; stateVersion: number } }
export interface MockBankWriteRecord { operation: StoredResponse["operation"]; idempotencyKey: string; requestHash: string; response: StoredResponse["response"] }
export interface MockBankOptions { afterWrite?: (record: MockBankWriteRecord) => void }

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
const BENEFICIARY_DEFINITIONS = [
  { id: "ben-ntu", name: "Nanyang Technological University", supportedCurrencies: ["USD"], status: "ACTIVE" as const },
  { id: "ben-john-1", name: "John Tan", supportedCurrencies: ["USD"], status: "ACTIVE" as const },
  { id: "ben-john-2", name: "John Lim", supportedCurrencies: ["USD"], status: "ACTIVE" as const },
];
const ASSET_DEFINITIONS = [{ id: "asset-aapl", symbol: "AAPL", name: "Apple Inc.", assetType: "EQUITY" as const, tradable: true, settlementCurrency: "USD" }];
const DEMO_ASSET_QUOTE = AssetQuoteV1.parse({
  quoteId: "asset-quote-aapl-usd-v1", assetId: "asset-aapl", settlementCurrency: "USD",
  unitPriceMinor: "20000", feeMinor: "100", expiresAt: "2099-01-01T00:00:00.000Z",
});
const fxDestinationAccountId = (currency: string): string | undefined => ACCOUNT_DEFINITIONS.find((account) => account.currency === currency)?.id;
const initialState = (): State => ({
  stateVersion: 7,
  balances: { "acc-sgd": 2_000_000n, "acc-usd": 500_000n },
  holdings: {},
  assets: ASSET_DEFINITIONS.map((asset) => ({ ...asset })),
  assetQuotes: [{ ...DEMO_ASSET_QUOTE }],
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
  const getState = (userId: string): State => { const existing = states.get(userId); if (existing) return existing; const created = initialState(); states.set(userId, created); return created; };
  const app = Fastify({ loggerInstance: logger });
  app.addHook("onRequest", async (request, reply) => { const traceId = resolveTraceId(request.headers["x-trace-id"]); request.headers["x-trace-id"] = traceId; reply.header("x-trace-id", traceId); });
  app.get("/health", async () => ({ status: "ok", service: "mock-bank" })); app.get("/ready", async () => ({ status: "ready" }));
  app.get("/v1/executions/idempotency/:key", async (request) => {
    const { key } = z.object({ key: Id }).parse(request.params); const prior = idempotency.get(key);
    return prior ? { status: "COMPLETED" as const, idempotencyKey: key, operation: prior.operation, requestHash: prior.requestHash, ...prior.response } : { status: "NOT_FOUND" as const, idempotencyKey: key };
  });
  app.get("/v1/state/:userId", async (request) => { const { userId } = z.object({ userId: Id }).parse(request.params); const state = getState(userId); return BankStateSnapshotV1.parse({
    schemaVersion: "1", userId, stateVersion: state.stateVersion, capturedAt: new Date().toISOString(),
    accounts: ACCOUNT_DEFINITIONS.map((account) => ({ ...account, capabilities: [...account.capabilities], ledgerMinorUnits: state.balances[account.id]!.toString(), availableMinorUnits: state.balances[account.id]!.toString(), status: "ACTIVE" as const })), beneficiaries: BENEFICIARY_DEFINITIONS.map((beneficiary) => ({ ...beneficiary, supportedCurrencies: [...beneficiary.supportedCurrencies] })), assets: state.assets,
    holdings: Object.entries(state.holdings).map(([assetId, quantity]) => ({ assetId, quantity })), obligations: [], serviceAvailability: { transfers: !state.scenarios.has("TRANSFER_RAIL_UNAVAILABLE"), fx: !state.scenarios.has("FX_UNAVAILABLE"), billPayments: !state.scenarios.has("TRANSFER_RAIL_UNAVAILABLE"), investments: !state.scenarios.has("ASSET_UNAVAILABLE") },
    fxQuotes: [{ id: `q-${userId}-${state.stateVersion}`, fromCurrency: "SGD", toCurrency: "USD", rate: "0.75", expiresAt: new Date(Date.now() + 60_000).toISOString() }], assetQuotes: state.assetQuotes,
  }); });
  app.post("/v1/fx/quote", async (request, reply) => { const body = QuoteBody.parse(request.body); const state = getState(body.userId); if (state.scenarios.has("FX_UNAVAILABLE")) return reply.code(503).send({ code: "FX_UNAVAILABLE" }); return { id: `q-${body.userId}-${state.stateVersion}`, fromCurrency: body.fromCurrency, toCurrency: body.toCurrency, rate: "0.75", expiresAt: new Date(Date.now() + 60_000).toISOString() }; });
  const debit = (state: State, accountId: string, money: { minorUnits: string }): void => { const balance = state.balances[accountId]; if (balance === undefined) throw new Error("ACCOUNT_NOT_FOUND"); const amount = BigInt(money.minorUnits); if (balance < amount) throw new Error("INSUFFICIENT_FUNDS"); state.balances[accountId] = balance - amount; };
  const execute = <T extends WriteBody>(path: "fx" | "transfer" | "payment" | "buy", schema: z.ZodType<T>, blocked: Scenario, mutate: (state: State, body: T) => void) => app.post(`/v1/execute/${path}`, async (request, reply) => {
    const key = request.headers["idempotency-key"]; if (typeof key !== "string" || !key) return reply.code(400).send({ code: "IDEMPOTENCY_KEY_REQUIRED" });
    const body = schema.parse(request.body); const hash = requestHash(body); const prior = idempotency.get(key); if (prior) return prior.operation === path && prior.requestHash === hash ? prior.response : reply.code(409).send({ code: "IDEMPOTENCY_KEY_REUSED" });
    const state = getState(body.userId); if (state.scenarios.has(blocked)) return reply.code(503).send({ code: blocked }); if (path === "fx" && state.scenarios.has("QUOTE_EXPIRED")) return reply.code(409).send({ code: "QUOTE_EXPIRED" }); if (state.scenarios.has("BALANCE_CHANGED")) return reply.code(409).send({ code: "BALANCE_CHANGED", stateVersion: state.stateVersion });
    try { mutate(state, body); } catch (error) { return reply.code(409).send({ code: error instanceof Error ? error.message : "WRITE_REJECTED" }); }
    state.stateVersion += 1; const response = { accepted: true as const, bankReference: `mock-${key}`, stateVersion: state.stateVersion }; const record = { operation: path, idempotencyKey: key, requestHash: hash, response }; idempotency.set(key, { operation: path, requestHash: hash, response }); options.afterWrite?.(record); return response;
  });
  execute("fx", FxBody, "FX_UNAVAILABLE", (state, body) => { debit(state, body.accountId, body.fromAmount); const target = fxDestinationAccountId(body.toCurrency); if (!target) throw new Error("FX_DESTINATION_ACCOUNT_NOT_FOUND"); state.balances[target] = (state.balances[target] ?? 0n) + multiplyRateHalfEven(body.fromAmount.minorUnits, 75n, 100n); });
  execute("transfer", TransferBody, "TRANSFER_RAIL_UNAVAILABLE", (state, body) => { debit(state, body.sourceAccountId, body.amount); if ("destinationAccountId" in body) state.balances[body.destinationAccountId] = (state.balances[body.destinationAccountId] ?? 0n) + BigInt(body.amount.minorUnits); });
  execute("payment", PaymentBody, "TRANSFER_RAIL_UNAVAILABLE", (state, body) => debit(state, body.sourceAccountId, body.amount)); execute("buy", BuyBody, "ASSET_UNAVAILABLE", (state, body) => {
    const quote = state.assetQuotes.find((item) => item.quoteId === body.quoteId); if (!quote) throw new Error("ASSET_QUOTE_NOT_FOUND");
    if (quote.assetId !== body.assetId) throw new Error("ASSET_QUOTE_ASSET_MISMATCH");
    const asset = state.assets.find((item) => item.id === body.assetId); if (!asset?.tradable) throw new Error("ASSET_NOT_TRADABLE");
    if (quote.settlementCurrency !== body.settlementCurrency || asset.settlementCurrency !== body.settlementCurrency) throw new Error("ASSET_QUOTE_SETTLEMENT_CURRENCY_MISMATCH");
    const account = ACCOUNT_DEFINITIONS.find((item) => item.id === body.sourceAccountId); if (!account || account.currency !== body.settlementCurrency) throw new Error("SOURCE_ACCOUNT_CURRENCY_MISMATCH");
    if (Date.parse(quote.expiresAt) <= Date.now()) throw new Error("ASSET_QUOTE_EXPIRED");
    if (body.quotedUnitPriceMinor !== quote.unitPriceMinor) throw new Error("ASSET_QUOTE_UNIT_PRICE_MISMATCH");
    if (body.quotedFeeMinor !== quote.feeMinor) throw new Error("ASSET_QUOTE_FEE_MISMATCH");
    const total = authoritativeAssetTotal(body.quantity, quote.unitPriceMinor, quote.feeMinor);
    if (BigInt(body.authorizedTotalMinor) !== total) throw new Error("AUTHORIZED_TOTAL_MISMATCH");
    if (body.maximumSpend.currency !== body.settlementCurrency) throw new Error("MAXIMUM_SPEND_CURRENCY_MISMATCH");
    if (total > BigInt(body.maximumSpend.minorUnits)) throw new Error("MAXIMUM_SPEND_EXCEEDED");
    debit(state, body.sourceAccountId, { minorUnits: body.authorizedTotalMinor });
    state.holdings[body.assetId] = addDecimalStrings(state.holdings[body.assetId] ?? "0", body.quantity);
  });
  app.get("/v1/admin/scenarios/:userId", async (request) => { const { userId } = z.object({ userId: Id }).parse(request.params); return { scenarios: [...getState(userId).scenarios] }; });
  app.post("/v1/admin/scenarios/:userId", async (request) => { const { userId } = z.object({ userId: Id }).parse(request.params); const body = z.object({ scenarios: z.array(z.enum(["FX_UNAVAILABLE", "TRANSFER_RAIL_UNAVAILABLE", "ASSET_UNAVAILABLE", "BALANCE_CHANGED", "QUOTE_EXPIRED"])) }).parse(request.body); const state = getState(userId); state.scenarios = new Set(body.scenarios); return { scenarios: [...state.scenarios] }; });
  app.put("/v1/admin/asset-quotes/:userId", async (request) => { const { userId } = z.object({ userId: Id }).parse(request.params); const body = z.object({ assetQuotes: z.array(AssetQuoteV1) }).strict().parse(request.body); const state = getState(userId); state.assetQuotes = body.assetQuotes; return { assetQuotes: state.assetQuotes }; });
  app.put("/v1/admin/assets/:userId", async (request) => { const { userId } = z.object({ userId: Id }).parse(request.params); const body = z.object({ assets: z.array(AssetV1) }).strict().parse(request.body); const state = getState(userId); state.assets = body.assets; return { assets: state.assets }; });
  return app;
}
