import Fastify from "fastify";
import { z } from "zod";
import { logger, resolveTraceId } from "@parlance/observability";

type Scenario = "FX_UNAVAILABLE" | "TRANSFER_RAIL_UNAVAILABLE" | "ASSET_UNAVAILABLE" | "BALANCE_CHANGED" | "QUOTE_EXPIRED";
interface State { stateVersion: number; balances: Record<string, number>; scenarios: Set<Scenario>; }
const states = new Map<string, State>();
const idempotency = new Map<string, unknown>();
const getState = (userId: string): State => {
  const existing = states.get(userId);
  if (existing) return existing;
  const created = { stateVersion: 1, balances: { SGD: 10000, USD: 5000 }, scenarios: new Set<Scenario>() };
  states.set(userId, created); return created;
};
const WriteBody = z.object({ userId: z.string().min(1), amount: z.number().positive(), currency: z.string().length(3) });

export function buildApp() {
  const app = Fastify({ loggerInstance: logger });
  app.addHook("onRequest", async (request, reply) => { const traceId = resolveTraceId(request.headers["x-trace-id"]); request.headers["x-trace-id"] = traceId; reply.header("x-trace-id", traceId); });
  app.get("/health", async () => ({ status: "ok", service: "mock-bank" }));
  app.get("/ready", async () => ({ status: "ready" }));
  app.get("/v1/state/:userId", async (request) => { const { userId } = z.object({ userId: z.string() }).parse(request.params); const state = getState(userId); return { userId, stateVersion: state.stateVersion, balances: state.balances, capturedAt: new Date().toISOString() }; });
  app.post("/v1/fx/quote", async (request, reply) => { const body = WriteBody.parse(request.body); const state = getState(body.userId); if (state.scenarios.has("FX_UNAVAILABLE")) return reply.code(503).send({ code: "FX_UNAVAILABLE" }); return { quoteId: `q-${body.userId}-${state.stateVersion}`, rate: 0.75, expiresAt: new Date(Date.now() + 30_000).toISOString() }; });
  const registerWrite = (path: string, blocked: Scenario) => app.post(path, async (request, reply) => {
    const key = request.headers["idempotency-key"];
    if (typeof key !== "string" || !key) return reply.code(400).send({ code: "IDEMPOTENCY_KEY_REQUIRED" });
    if (idempotency.has(key)) return idempotency.get(key);
    const body = WriteBody.parse(request.body); const state = getState(body.userId);
    if (state.scenarios.has(blocked)) return reply.code(503).send({ code: blocked });
    if (path.endsWith("/fx") && state.scenarios.has("QUOTE_EXPIRED")) return reply.code(409).send({ code: "QUOTE_EXPIRED" });
    if (state.scenarios.has("BALANCE_CHANGED")) return reply.code(409).send({ code: "BALANCE_CHANGED", stateVersion: state.stateVersion });
    state.balances[body.currency] = (state.balances[body.currency] ?? 0) - body.amount;
    state.stateVersion += 1;
    const result = { accepted: true, bankReference: `mock-${key}`, stateVersion: state.stateVersion };
    idempotency.set(key, result); return result;
  });
  registerWrite("/v1/execute/fx", "FX_UNAVAILABLE"); registerWrite("/v1/execute/transfer", "TRANSFER_RAIL_UNAVAILABLE");
  registerWrite("/v1/execute/payment", "TRANSFER_RAIL_UNAVAILABLE"); registerWrite("/v1/execute/buy", "ASSET_UNAVAILABLE");
  app.post("/v1/admin/scenarios/:userId", async (request) => { const { userId } = z.object({ userId: z.string() }).parse(request.params); const body = z.object({ scenarios: z.array(z.enum(["FX_UNAVAILABLE", "TRANSFER_RAIL_UNAVAILABLE", "ASSET_UNAVAILABLE", "BALANCE_CHANGED", "QUOTE_EXPIRED"])) }).parse(request.body); const state = getState(userId); state.scenarios = new Set(body.scenarios); return { scenarios: [...state.scenarios] }; });
  return app;
}
