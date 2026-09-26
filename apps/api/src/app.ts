import Fastify from "fastify";
import { z } from "zod";
import { logger, resolveTraceId } from "@parlance/observability";
import { getPrismaClient } from "@parlance/db";
import { registerRoutes } from "./routes/index.js";
import { CompilerClient } from "./clients/compiler.js";
import { MockBankClient } from "./clients/mock-bank.js";
import { createTokenHubIntentInterpreter, MockIntentInterpreter } from "@parlance/intent-engine";
import { ApprovalService, CompilationService, ExecutionService, MessageOrchestrationService } from "./orchestration/services.js";
import type { GoalConfirmationRepository, ParlanceRepository } from "./orchestration/ports.js";
import { PrismaParlanceRepository } from "./repositories/prisma.js";
import { PrismaEntityGrounder } from "./repositories/prisma-grounder.js";
import { WebAuthnService } from "./webauthn/service.js";
import type { WebAuthnRepository } from "./webauthn/types.js";

export interface ApiServices { repository: ParlanceRepository & GoalConfirmationRepository & WebAuthnRepository; messages: MessageOrchestrationService; compilation: CompilationService; approval: ApprovalService; execution: ExecutionService; webauthn: WebAuthnService; dependencies: { compiler: CompilerClient; bank: MockBankClient } }
export function productionServices(): ApiServices {
  const db = getPrismaClient(); const repository = new PrismaParlanceRepository(db); const bank = new MockBankClient(); const compiler = new CompilerClient();
  const intentMode = process.env.INTENT_INTERPRETER_MODE ?? "TOKENHUB";
  if (intentMode !== "TOKENHUB" && intentMode !== "MOCK") throw new Error("INTENT_INTERPRETER_MODE_INVALID");
  const interpreter = intentMode === "MOCK" ? new MockIntentInterpreter() : createTokenHubIntentInterpreter();
  return { repository, messages: new MessageOrchestrationService(repository, interpreter, (userId) => new PrismaEntityGrounder(db, userId)), compilation: new CompilationService(repository, bank, compiler), approval: new ApprovalService(repository), execution: new ExecutionService(repository, bank, compiler), webauthn: new WebAuthnService(repository, bank), dependencies: { compiler, bank } };
}
export function buildApp(services = productionServices()) {
  const app = Fastify({ loggerInstance: logger });
  app.addHook("onRequest", async (request, reply) => { const traceId = resolveTraceId(request.headers["x-trace-id"]); request.headers["x-trace-id"] = traceId; reply.header("x-trace-id", traceId); });
  app.get("/health", async () => ({ status: "ok", service: "api" }));
  app.get("/ready", async (request, reply) => {
    const missing = ["DATABASE_URL", "DIRECT_URL", "COMPILER_URL", "MOCK_BANK_URL"].filter((key) => !process.env[key]); if (missing.length) return reply.code(503).send({ status: "not_ready", database: "not_checked", missing });
    const traceId = String(request.headers["x-trace-id"]); const [databaseReady, compilerReady, mockBankReady] = await Promise.all([services.repository.isReady(), services.dependencies.compiler.isReady(traceId), services.dependencies.bank.isReady(traceId)]);
    if (!databaseReady || !compilerReady || !mockBankReady) return reply.code(503).send({ status: "not_ready", database: databaseReady ? "ready" : "unavailable", dependencies: { compiler: compilerReady ? "ready" : "unavailable", mockBank: mockBankReady ? "ready" : "unavailable" } });
    return { status: "ready", database: "ready", dependencies: { compiler: "ready", mockBank: "ready" } };
  });
  app.setErrorHandler((error, _request, reply) => { const message = error instanceof Error ? error.message : "INTERNAL_ERROR"; const status = error instanceof z.ZodError ? 400 : /NOT_FOUND/.test(message) ? 404 : message === "COMPILER_UNAVAILABLE" || message === "MOCK_BANK_UNAVAILABLE" ? 503 : 409; return reply.code(status).send({ code: error instanceof z.ZodError ? "INVALID_REQUEST" : message, details: error instanceof z.ZodError ? error.issues : undefined }); });
  void app.register(registerRoutes, services); return app;
}
