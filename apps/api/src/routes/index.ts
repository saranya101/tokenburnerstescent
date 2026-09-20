import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { receiveMessage, placeholder } from "../orchestration/handlers.js";
const RouteId = z.object({ id: z.string().min(1) });
export async function registerRoutes(app: FastifyInstance) {
  app.post("/v1/messages", async (request) => receiveMessage(request.body));
  app.post("/v1/goals/:id/confirm", async (request) => placeholder("goal-confirmation", RouteId.parse(request.params).id));
  app.post("/v1/goals/:id/compile", async (request) => placeholder("goal-compilation", RouteId.parse(request.params).id));
  app.post("/v1/plans/:id/approve", async (request) => placeholder("plan-approval", RouteId.parse(request.params).id));
  app.post("/v1/executions/:id/run", async (request) => placeholder("execution-run", RouteId.parse(request.params).id));
  app.get("/v1/executions/:id", async (request) => placeholder("execution", RouteId.parse(request.params).id));
  app.get("/v1/opportunities", async () => []); app.get("/v1/ops/executions", async () => []); app.get("/v1/ops/audit", async () => []);
  app.get("/v1/traces/:id/events", async (_request, reply) => { reply.header("content-type", "text/event-stream"); return "event: ready\ndata: {\"authoritative\":false}\n\n"; });
}
