import { createHash } from "node:crypto";
import Fastify from "fastify";
import { BankStateSnapshotV1, MoneyV1 } from "@parlance/contracts";
import { z } from "zod";
import { logger, resolveTraceId } from "@parlance/observability";

type Scenario = "FX_UNAVAILABLE" | "TRANSFER_RAIL_UNAVAILABLE" | "ASSET_UNAVAILABLE" | "BALANCE_CHANGED" | "QUOTE_EXPIRED";
interface State { stateVersion: number; balances: Record<string, bigint>; holdings: Record<string, string>; scenarios: Set<Scenario> }
interface StoredResponse { requestHash: string; response: { accepted: true; bankReference: string; stateVersion: number } }

const Id = z.string().min(1);
const FxBody = z.object({ userId: Id, accountId: Id, fromAmount: MoneyV1, toCurrency: z.string().length(3), quoteId: Id }).strict();
const TransferBody = z.union([z.object({ userId: Id, sourceAccountId: Id, beneficiaryId: Id, amount: MoneyV1 }).strict(), z.object({ userId: Id, sourceAccountId: Id, destinationAccountId: Id, amount: MoneyV1 }).strict()]);
const PaymentBody = z.object({ userId: Id, sourceAccountId: Id, obligationId: Id, amount: MoneyV1 }).strict();
const BuyBody = z.object({ userId: Id, sourceAccountId: Id, assetId: Id, quantity: z.string().regex(/^\d+(?:\.\d+)?$/), maximumSpend: MoneyV1 }).strict();
type WriteBody = z.infer<typeof FxBody> | z.infer<typeof TransferBody> | z.infer<typeof PaymentBody> | z.infer<typeof BuyBody>;
const QuoteBody = z.object({ userId: Id, fromCurrency: z.string().length(3), toCurrency: z.string().length(3), amount: MoneyV1 }).strict();
const initialState = (): State => ({ stateVersion: 7, balances: { "acc-sgd": 2_000_000n, "acc-usd": 500_000n }, holdings: {}, scenarios: new Set() });
const requestHash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function buildApp() {
  const states = new Map<string, State>(); const idempotency = new Map<string, StoredResponse>();
  const getState = (userId: string): State => { const existing = states.get(userId); if (existing) return existing; const created = initialState(); states.set(userId, created); return created; };
  const app = Fastify({ loggerInstance: logger });
  app.addHook("onRequest", async (request, reply) => { const traceId = resolveTraceId(request.headers["x-trace-id"]); request.headers["x-trace-id"] = traceId; reply.header("x-trace-id", traceId); });
  app.get("/health", async () => ({ status: "ok", service: "mock-bank" })); app.get("/ready", async () => ({ status: "ready" }));
  app.get("/v1/state/:userId", async (request) => { const { userId } = z.object({ userId: Id }).parse(request.params); const state = getState(userId); return BankStateSnapshotV1.parse({
    schemaVersion: "1", userId, stateVersion: state.stateVersion, capturedAt: new Date().toISOString(),
    accounts: [
      { id: "acc-sgd", type: "CHECKING", currency: "SGD", ledgerMinorUnits: state.balances["acc-sgd"]!.toString(), availableMinorUnits: state.balances["acc-sgd"]!.toString(), status: "ACTIVE", capabilities: ["SEND_TRANSFER", "RECEIVE_TRANSFER", "CONVERT_FX", "PAY_BILL", "TRADE_ASSET"] },
      { id: "acc-usd", type: "CHECKING", currency: "USD", ledgerMinorUnits: state.balances["acc-usd"]!.toString(), availableMinorUnits: state.balances["acc-usd"]!.toString(), status: "ACTIVE", capabilities: ["SEND_TRANSFER", "RECEIVE_TRANSFER", "CONVERT_FX"] },
    ], beneficiaries: [{ id: "ben-ntu", name: "Nanyang Technological University", supportedCurrencies: ["USD"], status: "ACTIVE" }], assets: [{ id: "asset-aapl", symbol: "AAPL", name: "Apple Inc.", assetType: "EQUITY", tradable: true, settlementCurrency: "USD" }],
    holdings: Object.entries(state.holdings).map(([assetId, quantity]) => ({ assetId, quantity })), obligations: [], serviceAvailability: { transfers: !state.scenarios.has("TRANSFER_RAIL_UNAVAILABLE"), fx: !state.scenarios.has("FX_UNAVAILABLE"), billPayments: !state.scenarios.has("TRANSFER_RAIL_UNAVAILABLE"), investments: !state.scenarios.has("ASSET_UNAVAILABLE") },
    fxQuotes: [{ id: `q-${userId}-${state.stateVersion}`, fromCurrency: "SGD", toCurrency: "USD", rate: "0.75", expiresAt: new Date(Date.now() + 60_000).toISOString() }],
  }); });
  app.post("/v1/fx/quote", async (request, reply) => { const body = QuoteBody.parse(request.body); const state = getState(body.userId); if (state.scenarios.has("FX_UNAVAILABLE")) return reply.code(503).send({ code: "FX_UNAVAILABLE" }); return { id: `q-${body.userId}-${state.stateVersion}`, fromCurrency: body.fromCurrency, toCurrency: body.toCurrency, rate: "0.75", expiresAt: new Date(Date.now() + 60_000).toISOString() }; });
  const debit = (state: State, accountId: string, money: { minorUnits: string }): void => { const balance = state.balances[accountId]; if (balance === undefined) throw new Error("ACCOUNT_NOT_FOUND"); const amount = BigInt(money.minorUnits); if (balance < amount) throw new Error("INSUFFICIENT_FUNDS"); state.balances[accountId] = balance - amount; };
  const execute = <T extends WriteBody>(path: "fx" | "transfer" | "payment" | "buy", schema: z.ZodType<T>, blocked: Scenario, mutate: (state: State, body: T) => void) => app.post(`/v1/execute/${path}`, async (request, reply) => {
    const key = request.headers["idempotency-key"]; if (typeof key !== "string" || !key) return reply.code(400).send({ code: "IDEMPOTENCY_KEY_REQUIRED" });
    const body = schema.parse(request.body); const hash = requestHash(body); const prior = idempotency.get(key); if (prior) return prior.requestHash === hash ? prior.response : reply.code(409).send({ code: "IDEMPOTENCY_KEY_REUSED" });
    const state = getState(body.userId); if (state.scenarios.has(blocked)) return reply.code(503).send({ code: blocked }); if (path === "fx" && state.scenarios.has("QUOTE_EXPIRED")) return reply.code(409).send({ code: "QUOTE_EXPIRED" }); if (state.scenarios.has("BALANCE_CHANGED")) return reply.code(409).send({ code: "BALANCE_CHANGED", stateVersion: state.stateVersion });
    try { mutate(state, body); } catch (error) { return reply.code(409).send({ code: error instanceof Error ? error.message : "WRITE_REJECTED" }); }
    state.stateVersion += 1; const response = { accepted: true as const, bankReference: `mock-${key}`, stateVersion: state.stateVersion }; idempotency.set(key, { requestHash: hash, response }); return response;
  });
  execute("fx", FxBody, "FX_UNAVAILABLE", (state, body) => { debit(state, body.accountId, body.fromAmount); const target = body.toCurrency === "USD" ? "acc-usd" : "acc-sgd"; state.balances[target] = (state.balances[target] ?? 0n) + BigInt(body.fromAmount.minorUnits) * 75n / 100n; });
  execute("transfer", TransferBody, "TRANSFER_RAIL_UNAVAILABLE", (state, body) => { debit(state, body.sourceAccountId, body.amount); if ("destinationAccountId" in body) state.balances[body.destinationAccountId] = (state.balances[body.destinationAccountId] ?? 0n) + BigInt(body.amount.minorUnits); });
  execute("payment", PaymentBody, "TRANSFER_RAIL_UNAVAILABLE", (state, body) => debit(state, body.sourceAccountId, body.amount)); execute("buy", BuyBody, "ASSET_UNAVAILABLE", (state, body) => { debit(state, body.sourceAccountId, body.maximumSpend); state.holdings[body.assetId] = body.quantity; });
  app.post("/v1/admin/scenarios/:userId", async (request) => { const { userId } = z.object({ userId: Id }).parse(request.params); const body = z.object({ scenarios: z.array(z.enum(["FX_UNAVAILABLE", "TRANSFER_RAIL_UNAVAILABLE", "ASSET_UNAVAILABLE", "BALANCE_CHANGED", "QUOTE_EXPIRED"])) }).parse(request.body); const state = getState(userId); state.scenarios = new Set(body.scenarios); return { scenarios: [...state.scenarios] }; });
  return app;
}
