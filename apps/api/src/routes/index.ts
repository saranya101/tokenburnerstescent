import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ApiServices } from "../app.js";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
const RouteId = z.object({ id: z.string().min(1) });
const EmptyInput = z.object({}).strict();
const RegistrationVerificationInput = z.object({
  challengeId: z.string().min(1),
  credential: z.object({
    id: z.string().min(1), rawId: z.string().min(1), type: z.literal("public-key"),
    response: z.object({ clientDataJSON: z.string().min(1), attestationObject: z.string().min(1) }).catchall(z.unknown()),
    clientExtensionResults: z.object({}).catchall(z.unknown()),
    authenticatorAttachment: z.enum(["cross-platform", "platform"]).optional(),
  }).strict(),
}).strict();
const ApprovalVerificationInput = z.object({
  challengeId: z.string().min(1),
  credential: z.object({
    id: z.string().min(1), rawId: z.string().min(1), type: z.literal("public-key"),
    response: z.object({ clientDataJSON: z.string().min(1), authenticatorData: z.string().min(1), signature: z.string().min(1), userHandle: z.string().optional() }).strict(),
    clientExtensionResults: z.object({}).catchall(z.unknown()),
    authenticatorAttachment: z.enum(["cross-platform", "platform"]).optional(),
  }).strict(),
}).strict();
const trace = (headers: Record<string, unknown>): string => String(headers["x-trace-id"]);
export async function registerRoutes(app: FastifyInstance, services: ApiServices) {
  app.post("/v1/messages", async (request) => services.messages.receive(request.body, trace(request.headers)));
  app.post("/v1/goal-candidates/:id/confirm", async (request) => { EmptyInput.parse(request.body ?? {}); return services.messages.confirm(RouteId.parse(request.params).id, trace(request.headers)); });
  app.post("/v1/goals/:id/compile", async (request) => services.compilation.compile(RouteId.parse(request.params).id, trace(request.headers)));
  app.post("/v1/webauthn/registration/options", async (request) => { EmptyInput.parse(request.body ?? {}); return services.webauthn.registrationOptions(); });
  app.post("/v1/webauthn/registration/verify", async (request) => { const body = RegistrationVerificationInput.parse(request.body); return services.webauthn.verifyRegistration(body.challengeId, body.credential as RegistrationResponseJSON); });
  app.post("/v1/plans/:id/approval-options", async (request) => { EmptyInput.parse(request.body ?? {}); return services.webauthn.approvalOptions(RouteId.parse(request.params).id, trace(request.headers)); });
  app.post("/v1/plans/:id/approval-verify", async (request) => { const body = ApprovalVerificationInput.parse(request.body); return services.webauthn.verifyApproval(RouteId.parse(request.params).id, body.challengeId, body.credential as AuthenticationResponseJSON, trace(request.headers)); });
  app.post("/v1/executions/:id/run", async (request) => services.execution.run(RouteId.parse(request.params).id, trace(request.headers)));
  app.get("/v1/executions/:id", async (request, reply) => { const value = await services.execution.get(RouteId.parse(request.params).id); return value ? value.result : reply.code(404).send({ code: "EXECUTION_NOT_FOUND" }); });
  app.get("/v1/executions/:id/detail", async (request, reply) => { const value = await services.execution.detail(RouteId.parse(request.params).id); return value ?? reply.code(404).send({ code: "EXECUTION_NOT_FOUND" }); });
  app.get("/v1/opportunities", async () => []); app.get("/v1/ops/executions", async () => (await services.execution.list()).map((item) => ({ state: item.executionState, result: item.result }))); app.get("/v1/ops/executions/recoverable", async () => (await services.execution.listRecoverable()).map((item) => ({ state: item.executionState, approvalId: item.approvalId, traceId: item.traceId, result: item.result }))); app.get("/v1/ops/audit", async () => services.repository.listAudit());
  app.get("/v1/traces/:id/events", async (_request, reply) => { reply.header("content-type", "text/event-stream"); return "event: ready\ndata: {\"authoritative\":false}\n\n"; });
}
