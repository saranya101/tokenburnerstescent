import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { getPrismaClient } from "@parlance/db";
import { logger, resolveTraceId } from "@parlance/observability";
import { PrismaRecoveryWorkStore, processNextRecovery } from "./jobs/reconciliation.js";
const app = Fastify({ loggerInstance: logger });
app.addHook("onRequest", async (request, reply) => { const traceId = resolveTraceId(request.headers["x-trace-id"]); reply.header("x-trace-id", traceId); });
app.get("/health", async () => ({ status: "ok", service: "worker" }));
app.get("/ready", async (_request, reply) => process.env.REDIS_URL ? { status: "ready" } : reply.code(503).send({ status: "not_ready", missing: ["REDIS_URL"] }));
const apiUrl = process.env.API_URL ?? "http://127.0.0.1:4001"; const db = getPrismaClient(); const recoveryStore = new PrismaRecoveryWorkStore(db, randomUUID); let recoveryRunning = false;
const recoveryTimer = setInterval(() => { if (recoveryRunning) return; recoveryRunning = true; void processNextRecovery(recoveryStore, {
  async recover(executionId, traceId) {
    const response = await fetch(`${apiUrl}/v1/executions/${encodeURIComponent(executionId)}/run`, { method: "POST", headers: { "x-trace-id": traceId } });
    if (!response.ok) throw new Error(`RECOVERY_API_${response.status}`);
    const result = await response.json() as { status?: string; steps?: Array<{ status?: string; errorCode?: string }> };
    const recoveryErrors = new Set(["BANK_RESPONSE_OUTCOME_UNKNOWN", "BANK_LOOKUP_UNAVAILABLE"]);
    return result.status === "UNKNOWN" && result.steps?.some((step) => step.status === "UNKNOWN" && step.errorCode && recoveryErrors.has(step.errorCode)) ? "RETRY" : "RESOLVED";
  },
}).finally(() => { recoveryRunning = false; }); }, 1_000);
app.addHook("onClose", async () => { clearInterval(recoveryTimer); await db.$disconnect(); });
await app.listen({ port: Number(process.env.PORT ?? 4003), host: "0.0.0.0" });
