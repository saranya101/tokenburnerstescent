import Fastify from "fastify";
import { logger, resolveTraceId } from "@parlance/observability";
const app = Fastify({ loggerInstance: logger });
app.addHook("onRequest", async (request, reply) => { const traceId = resolveTraceId(request.headers["x-trace-id"]); reply.header("x-trace-id", traceId); });
app.get("/health", async () => ({ status: "ok", service: "worker" }));
app.get("/ready", async (_request, reply) => process.env.REDIS_URL ? { status: "ready" } : reply.code(503).send({ status: "not_ready", missing: ["REDIS_URL"] }));
// TODO: start BullMQ Worker consumers after durable DB adapters are wired.
await app.listen({ port: Number(process.env.PORT ?? 4003), host: "0.0.0.0" });
