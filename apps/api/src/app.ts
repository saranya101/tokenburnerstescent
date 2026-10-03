import Fastify from "fastify";
import { z } from "zod";
import { logger, resolveTraceId } from "@parlance/observability";
import { getPrismaClient } from "@parlance/db";
import { registerRoutes } from "./routes/index.js";
import { CompilerClient } from "./clients/compiler.js";
import { MockBankClient } from "./clients/mock-bank.js";
import { createTokenHubIntentBundleInterpreter, createTokenHubIntentInterpreter, MockIntentInterpreter, type IntentBundleInterpreter } from "@parlance/intent-engine";
import { CompilationService, ExecutionService, MessageOrchestrationService } from "./orchestration/services.js";
import { BundleMessageOrchestrationService } from "./orchestration/bundle-services.js";
import { BundleCompilationService } from "./orchestration/bundle-compilation.js";
import type { BundleConfirmationRepository, BundlePlanRepository, GoalConfirmationRepository, ParlanceRepository } from "./orchestration/ports.js";
import { PrismaParlanceRepository } from "./repositories/prisma.js";
import { PrismaEntityGrounder } from "./repositories/prisma-grounder.js";
import { WebAuthnService } from "./webauthn/service.js";
import type { WebAuthnRepository } from "./webauthn/types.js";
import { PrismaOpsReadService, type OpsReadService } from "./ops/read-model.js";
import { PrismaCustomerActivityReadService, type CustomerActivityReadService } from "./customer/activity.js";
import { PrismaRiskRepository } from "./risk/repository.js";
import { DeterministicApprovalRiskGate } from "./risk/gate.js";

export interface ApiServices { repository: ParlanceRepository & BundlePlanRepository & GoalConfirmationRepository & BundleConfirmationRepository & WebAuthnRepository; messages: MessageOrchestrationService; bundles: BundleMessageOrchestrationService; compilation: CompilationService; bundleCompilation: BundleCompilationService; execution: ExecutionService; webauthn: WebAuthnService; ops?: OpsReadService; customerActivity?: CustomerActivityReadService; dependencies: { compiler: CompilerClient; bank: MockBankClient } }
export function productionServices(): ApiServices {
  const db = getPrismaClient(); const repository = new PrismaParlanceRepository(db); const bank = new MockBankClient(); const compiler = new CompilerClient();
  const riskGate = new DeterministicApprovalRiskGate(new PrismaRiskRepository(db));
  const intentMode = process.env.INTENT_INTERPRETER_MODE ?? "TOKENHUB";
  if (intentMode !== "TOKENHUB" && intentMode !== "MOCK") throw new Error("INTENT_INTERPRETER_MODE_INVALID");
  const interpreter = intentMode === "MOCK" ? new MockIntentInterpreter() : createTokenHubIntentInterpreter();
  const bundleInterpreter: IntentBundleInterpreter = intentMode === "TOKENHUB" ? createTokenHubIntentBundleInterpreter() : { async interpretUserRequest() { throw new Error("BUNDLE_INTERPRETER_UNAVAILABLE"); } };
  const grounder = (userId: string) => new PrismaEntityGrounder(db, userId);
  return { repository, messages: new MessageOrchestrationService(repository, interpreter, grounder), bundles: new BundleMessageOrchestrationService(repository, bundleInterpreter, grounder), compilation: new CompilationService(repository, bank, compiler), bundleCompilation: new BundleCompilationService(repository, bank, compiler), execution: new ExecutionService(repository, bank, compiler), webauthn: new WebAuthnService(repository, bank, undefined, undefined, undefined, riskGate), ops: new PrismaOpsReadService(db), customerActivity: new PrismaCustomerActivityReadService(db), dependencies: { compiler, bank } };
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
  app.setErrorHandler((error, _request, reply) => { const message = error instanceof Error ? error.message : "INTERNAL_ERROR"; const status = error instanceof z.ZodError ? 400 : /NOT_FOUND/.test(message) ? 404 : /(?:COMPILER|INTERPRETER)_UNAVAILABLE/.test(message) || message === "MOCK_BANK_UNAVAILABLE" ? 503 : 409; return reply.code(status).send({ code: error instanceof z.ZodError ? "INVALID_REQUEST" : message, details: error instanceof z.ZodError ? error.issues : undefined }); });
  void app.register(registerRoutes, services); return app;
}
