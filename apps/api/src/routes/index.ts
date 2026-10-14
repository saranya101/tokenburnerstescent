import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ApiServices } from "../app.js";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { ConversationalMessageInput } from "../orchestration/input-provenance.js";
import {
  authenticateCustomer, authenticateOperator, customerAuthorizationConfigured, operatorAuthorizationConfigured,
  CustomerOwnership, type ApiAuthorizationConfig,
} from "../security/request-authorization.js";
const RouteId = z.object({ id: z.string().min(1) });
const EmptyInput = z.object({}).strict();
const ClarificationAnswerInput = z.union([z.object({ selectedCandidateId: z.string().min(1) }).strict(), z.object({ answerText: z.string().trim().min(1) }).strict()]);
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
const CustomerMessageBoundary = z.object({ userId: z.never().optional() }).passthrough();
const trace = (headers: Record<string, unknown>): string => String(headers["x-trace-id"]);

export async function registerRoutes(app: FastifyInstance, options: { services: ApiServices; authorization: ApiAuthorizationConfig }) {
  const { services, authorization } = options;
  const ownership = new CustomerOwnership(services);
  app.decorateRequest("customerPrincipal", undefined);
  // The API trusts customer identity only after the web BFF proves possession of the internal credential.
  const customerAuth = async (request: Parameters<typeof authenticateCustomer>[0], reply: { code(status: number): { send(body: object): unknown } }) => {
    if (!customerAuthorizationConfigured(authorization)) return reply.code(503).send({ code: "SERVICE_UNAVAILABLE" });
    const principal = authenticateCustomer(request, authorization);
    if (!principal) return reply.code(401).send({ code: "UNAUTHORIZED" });
    request.customerPrincipal = principal;
  };
  const operatorAuth = async (request: Parameters<typeof authenticateOperator>[0], reply: { code(status: number): { send(body: object): unknown } }) => {
    // Operator authorization is intentionally separate from the customer principal boundary.
    if (!operatorAuthorizationConfigured(authorization)) return reply.code(503).send({ code: "SERVICE_UNAVAILABLE" });
    if (!authenticateOperator(request, authorization)) return reply.code(401).send({ code: "UNAUTHORIZED" });
  };
  const customer = { preHandler: customerAuth };
  const operator = { preHandler: operatorAuth };
  const principal = (request: { customerPrincipal?: { userId: string } }) => {
    if (!request.customerPrincipal) throw new Error("UNAUTHORIZED");
    return request.customerPrincipal;
  };
  app.get("/v1/customer/state", customer, async (request) => {
    return services.dependencies.bank.getState(principal(request).userId, trace(request.headers));
  });
  app.get("/v1/customer/activity", customer, async (request, reply) => {
    if (!services.customerActivity) return reply.code(503).send({ code: "CUSTOMER_ACTIVITY_UNAVAILABLE" });
    return services.customerActivity.list(principal(request).userId);
  });
  app.get("/v1/customer/operations", customer, async (request, reply) => services.customerOperations ? services.customerOperations.list(principal(request).userId) : reply.code(503).send({ code: "CUSTOMER_OPERATIONS_UNAVAILABLE" }));
  app.get("/v1/customer/journeys", customer, async (request, reply) => services.customerJourneys ? services.customerJourneys.list(principal(request).userId) : reply.code(503).send({ code: "CUSTOMER_JOURNEYS_UNAVAILABLE" }));
  app.post("/v1/messages", customer, async (request) => {
    const external = CustomerMessageBoundary.parse(request.body);
    const body = ConversationalMessageInput.parse({ ...external, userId: principal(request).userId });
    return services.bundles?.handles(body.text) ? services.bundles.receive(body, trace(request.headers)) : services.messages.receive(body, trace(request.headers));
  });
  app.post("/v1/clarifications/:id/answer", customer, async (request) => { const id = RouteId.parse(request.params).id; await ownership.clarification(id, principal(request)); return services.messages.answerClarification(id, ClarificationAnswerInput.parse(request.body), trace(request.headers)); });
  app.post("/v1/bundle-clarifications/:id/answer", customer, async (request) => { const id = RouteId.parse(request.params).id; await ownership.bundleClarification(id, principal(request)); return services.bundles.answerClarification(id, ClarificationAnswerInput.parse(request.body), trace(request.headers)); });
  app.post("/v1/goal-candidates/:id/confirm", customer, async (request) => { const id = RouteId.parse(request.params).id; EmptyInput.parse(request.body ?? {}); await ownership.goalCandidate(id, principal(request)); return services.messages.confirm(id, trace(request.headers)); });
  app.post("/v1/goal-bundle-candidates/:id/confirm", customer, async (request) => { const id = RouteId.parse(request.params).id; EmptyInput.parse(request.body ?? {}); await ownership.bundleCandidate(id, principal(request)); return services.bundles.confirm(id, trace(request.headers)); });
  app.post("/v1/goals/:id/compile", customer, async (request) => { const id = RouteId.parse(request.params).id; await ownership.goal(id, principal(request)); return services.compilation.compile(id, trace(request.headers)); });
  app.post("/v1/goals/:id/funding-candidate", customer, async (request) => { const id = RouteId.parse(request.params).id; await ownership.goal(id, principal(request)); return services.investmentFunding.propose(id, request.body, trace(request.headers)); });
  app.post("/v1/goal-bundles/:id/compile", customer, async (request) => { const id = RouteId.parse(request.params).id; await ownership.bundle(id, principal(request)); return services.bundleCompilation.compile(id, trace(request.headers)); });
  app.get("/v1/webauthn/registration/status", customer, async (request) => { requireDemoPrincipal(principal(request).userId); return services.webauthn.registrationStatus(); });
  app.post("/v1/webauthn/registration/options", customer, async (request) => { EmptyInput.parse(request.body ?? {}); requireDemoPrincipal(principal(request).userId); return services.webauthn.registrationOptions(); });
  app.post("/v1/webauthn/registration/verify", customer, async (request) => { const body = RegistrationVerificationInput.parse(request.body); await ownership.registrationChallenge(body.challengeId, principal(request)); return services.webauthn.verifyRegistration(body.challengeId, body.credential as RegistrationResponseJSON); });
  app.post("/v1/plans/:id/approval-options", customer, async (request) => { const id = RouteId.parse(request.params).id; EmptyInput.parse(request.body ?? {}); await ownership.plan(id, principal(request)); return services.webauthn.approvalOptions(id, trace(request.headers)); });
  app.post("/v1/plans/:id/approval-verify", customer, async (request) => { const id = RouteId.parse(request.params).id; const body = ApprovalVerificationInput.parse(request.body); await ownership.plan(id, principal(request)); await ownership.registrationChallenge(body.challengeId, principal(request)); return services.webauthn.verifyApproval(id, body.challengeId, body.credential as AuthenticationResponseJSON, trace(request.headers)); });
  app.post("/v1/executions/:id/run", customer, async (request) => { const id = RouteId.parse(request.params).id; await ownership.execution(id, principal(request)); return services.execution.run(id, trace(request.headers)); });
  app.get("/v1/executions/:id", customer, async (request, reply) => { const id = RouteId.parse(request.params).id; await ownership.execution(id, principal(request)); const value = await services.execution.get(id); return value ? value.result : reply.code(404).send({ code: "EXECUTION_NOT_FOUND" }); });
  app.get("/v1/executions/:id/detail", customer, async (request, reply) => { const id = RouteId.parse(request.params).id; await ownership.execution(id, principal(request)); const value = await services.execution.detail(id); return value ?? reply.code(404).send({ code: "EXECUTION_NOT_FOUND" }); });
  app.get("/v1/opportunities", customer, async () => []); app.get("/v1/ops/executions", operator, async () => (await services.execution.list()).map((item) => ({ state: item.executionState, result: item.result }))); app.get("/v1/ops/executions/recoverable", operator, async () => (await services.execution.listRecoverable()).map((item) => ({ state: item.executionState, approvalId: item.approvalId, traceId: item.traceId, result: item.result }))); app.get("/v1/ops/audit", operator, async () => services.repository.listAudit());
  app.get("/v1/ops/runs", operator, async (_request, reply) => services.ops ? services.ops.listRuns() : reply.code(503).send({ code: "OPS_READ_MODEL_UNAVAILABLE" }));
  app.post("/v1/ops/executions/:id/run", operator, async (request) => services.execution.run(RouteId.parse(request.params).id, trace(request.headers)));
  app.get("/v1/ops/executions/:id/detail", operator, async (request, reply) => { const value = await services.execution.opsDetail(RouteId.parse(request.params).id); return value ?? reply.code(404).send({ code: "EXECUTION_NOT_FOUND" }); });
  app.get("/v1/traces/:id/events", operator, async (_request, reply) => { reply.header("content-type", "text/event-stream"); return "event: ready\ndata: {\"authoritative\":false}\n\n"; });
}

function requireDemoPrincipal(userId: string): void {
  const demo = process.env.PARLANCE_DEMO_USER_ID?.trim();
  const customer = process.env.PARLANCE_CUSTOMER_USER_ID?.trim();
  if (!demo || !customer || demo !== customer || demo !== userId) throw new Error("CUSTOMER_RESOURCE_NOT_FOUND");
}
