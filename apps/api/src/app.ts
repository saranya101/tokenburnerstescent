import Fastify from "fastify";
import { logger, resolveTraceId } from "@parlance/observability";
import { registerRoutes } from "./routes/index.js";
export function buildApp() {
  const app = Fastify({ loggerInstance: logger });
  app.addHook("onRequest", async (request, reply) => { const traceId = resolveTraceId(request.headers["x-trace-id"]); request.headers["x-trace-id"] = traceId; reply.header("x-trace-id", traceId); });
  app.get("/health", async () => ({ status: "ok", service: "api" }));
  app.get("/ready", async (_request, reply) => { const missing = ["DATABASE_URL", "REDIS_URL", "COMPILER_URL", "MOCK_BANK_URL"].filter((key) => !process.env[key]); if (missing.length) return reply.code(503).send({ status: "not_ready", missing }); return { status: "ready" }; });
  void app.register(registerRoutes); return app;
}
