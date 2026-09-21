import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { receiveMessage } from "../orchestration/handlers.js";
import type { ApiServices } from "../app.js";
const RouteId = z.object({ id: z.string().min(1) });
const ApprovalInput = z.object({ userId: z.string().min(1), method: z.enum(["BIOMETRIC", "PASSKEY", "PIN", "EXTERNAL_SIGNATURE"]), signatureReference: z.string().min(1), expiresAt: z.iso.datetime().optional() }).strict();
const trace = (headers: Record<string, unknown>): string => String(headers["x-trace-id"]);
export async function registerRoutes(app: FastifyInstance, services: ApiServices) {
  app.post("/v1/messages", async (request) => receiveMessage(request.body));
  app.post("/v1/goals/:id/compile", async (request) => services.compilation.compile(RouteId.parse(request.params).id, trace(request.headers)));
  app.post("/v1/plans/:id/approve", async (request) => { const body = ApprovalInput.parse(request.body); return services.approval.approve(RouteId.parse(request.params).id, { userId: body.userId, method: body.method, signatureReference: body.signatureReference, ...(body.expiresAt ? { expiresAt: body.expiresAt } : {}) }, trace(request.headers)); });
  app.post("/v1/executions/:id/run", async (request) => services.execution.run(RouteId.parse(request.params).id, trace(request.headers)));
  app.get("/v1/executions/:id", async (request, reply) => { const value = await services.execution.get(RouteId.parse(request.params).id); return value ? value.result : reply.code(404).send({ code: "EXECUTION_NOT_FOUND" }); });
  app.get("/v1/opportunities", async () => []); app.get("/v1/ops/executions", async () => (await services.execution.list()).map((item) => item.result)); app.get("/v1/ops/audit", async () => services.repository.listAudit());
  app.get("/v1/traces/:id/events", async (_request, reply) => { reply.header("content-type", "text/event-stream"); return "event: ready\ndata: {\"authoritative\":false}\n\n"; });
}
