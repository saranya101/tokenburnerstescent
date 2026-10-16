import Fastify from "fastify";
import { z } from "zod";
import { logger, resolveTraceId } from "@parlance/observability";
import { getPrismaClient } from "@parlance/db";
import { registerRoutes } from "./routes/index.js";
import { CompilerClient } from "./clients/compiler.js";
import { MockBankClient } from "./clients/mock-bank.js";
import { createTokenHubIntentBundleInterpreter, createTokenHubIntentInterpreter, IntentInterpreterError, MockIntentInterpreter, MockIntentBundleInterpreter, type IntentBundleInterpreter } from "@parlance/intent-engine";
import { CompilationService, ExecutionService, InvestmentFundingService, MessageOrchestrationService } from "./orchestration/services.js";
import { BundleMessageOrchestrationService } from "./orchestration/bundle-services.js";
import { BundleCompilationService } from "./orchestration/bundle-compilation.js";
import type { BundleConfirmationRepository, BundlePlanRepository, GoalConfirmationRepository, ParlanceRepository } from "./orchestration/ports.js";
import { PrismaParlanceRepository } from "./repositories/prisma.js";
import { PrismaEntityGrounder } from "./repositories/prisma-grounder.js";
import { WebAuthnService } from "./webauthn/service.js";
import type { WebAuthnRepository } from "./webauthn/types.js";
import { PrismaOpsReadService, type OpsReadService } from "./ops/read-model.js";
import { PrismaCustomerActivityReadService, type CustomerActivityReadService } from "./customer/activity.js";
import { PrismaCustomerOperationsReadService } from "./customer/operations.js";
import { PrismaCustomerJourneysReadService } from "./customer/journeys.js";
import { PrismaRiskRepository } from "./risk/repository.js";
import { DeterministicApprovalRiskGate } from "./risk/gate.js";
import { DeterministicExecutionRiskGate } from "./risk/execution-gate.js";
import { apiAuthorizationFromEnvironment, apiSecurityConfigurationReady, type ApiAuthorizationConfig } from "./security/request-authorization.js";

export interface ApiServices { repository: ParlanceRepository & BundlePlanRepository & GoalConfirmationRepository & BundleConfirmationRepository & WebAuthnRepository; messages: MessageOrchestrationService; investmentFunding: InvestmentFundingService; bundles: BundleMessageOrchestrationService; compilation: CompilationService; bundleCompilation: BundleCompilationService; execution: ExecutionService; webauthn: WebAuthnService; ops?: OpsReadService; customerActivity?: CustomerActivityReadService; customerOperations?: PrismaCustomerOperationsReadService; customerJourneys?: PrismaCustomerJourneysReadService; dependencies: { compiler: CompilerClient; bank: MockBankClient } }
export function productionServices(): ApiServices {
  const db = getPrismaClient(); const repository = new PrismaParlanceRepository(db); const bank = new MockBankClient(); const compiler = new CompilerClient();
  const riskRepository = new PrismaRiskRepository(db);
  const riskGate = new DeterministicApprovalRiskGate(riskRepository);
  const executionRiskGate = new DeterministicExecutionRiskGate(riskRepository);
  const intentMode = process.env.INTENT_INTERPRETER_MODE ?? "TOKENHUB";
  if (intentMode !== "TOKENHUB" && intentMode !== "MOCK") throw new Error("INTENT_INTERPRETER_MODE_INVALID");
  const interpreter = intentMode === "MOCK" ? new MockIntentInterpreter() : createTokenHubIntentInterpreter();
  const bundleInterpreter: IntentBundleInterpreter = intentMode === "TOKENHUB" ? createTokenHubIntentBundleInterpreter() : new MockIntentBundleInterpreter();
  const grounder = (userId: string) => new PrismaEntityGrounder(db, userId);
  return { repository, messages: new MessageOrchestrationService(repository, interpreter, grounder), investmentFunding: new InvestmentFundingService(repository, bank), bundles: new BundleMessageOrchestrationService(repository, bundleInterpreter, grounder), compilation: new CompilationService(repository, bank, compiler), bundleCompilation: new BundleCompilationService(repository, bank, compiler), execution: new ExecutionService(repository, bank, compiler, undefined, executionRiskGate), webauthn: new WebAuthnService(repository, bank, undefined, undefined, undefined, riskGate), ops: new PrismaOpsReadService(db), customerActivity: new PrismaCustomerActivityReadService(db), customerOperations: new PrismaCustomerOperationsReadService(db), customerJourneys: new PrismaCustomerJourneysReadService(db, repository), dependencies: { compiler, bank } };
}
export function buildApp(services = productionServices(), authorization: ApiAuthorizationConfig = apiAuthorizationFromEnvironment()) {
  const app = Fastify({ loggerInstance: logger });
  app.addHook("onRequest", async (request, reply) => { const traceId = resolveTraceId(request.headers["x-trace-id"]); request.headers["x-trace-id"] = traceId; reply.header("x-trace-id", traceId); });
  app.get("/health", async () => ({ status: "ok", service: "api" }));
  app.get("/ready", async (request, reply) => {
    if (!apiSecurityConfigurationReady(authorization)) return reply.code(503).send({ status: "not_ready" });
    const missing = ["DATABASE_URL", "DIRECT_URL", "COMPILER_URL", "MOCK_BANK_URL"].filter((key) => !process.env[key]); if (missing.length) return reply.code(503).send({ status: "not_ready", database: "not_checked", missing });
    const traceId = String(request.headers["x-trace-id"]); const [databaseReady, compilerReady, mockBankReady] = await Promise.all([services.repository.isReady(), services.dependencies.compiler.isReady(traceId), services.dependencies.bank.isReady(traceId)]);
    if (!databaseReady || !compilerReady || !mockBankReady) return reply.code(503).send({ status: "not_ready", database: databaseReady ? "ready" : "unavailable", dependencies: { compiler: compilerReady ? "ready" : "unavailable", mockBank: mockBankReady ? "ready" : "unavailable" } });
    return { status: "ready", database: "ready", dependencies: { compiler: "ready", mockBank: "ready" } };
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) return reply.code(400).send({ code: "INVALID_REQUEST", details: error.issues });
    if (error instanceof IntentInterpreterError) {
      const demoMessages = {
        DEMO_FX_UNAVAILABLE: "Standalone currency conversion isn't available in this demo because no exchange-rate quote is connected. You can review a transfer or an Apple share purchase instead. No money has moved.",
        DEMO_BILL_UNAVAILABLE: "Bill payments aren't available in this demo because no biller or outstanding bill is connected. You can review a transfer to a saved payee instead. No money has moved.",
        DEMO_REQUEST_UNSUPPORTED: "This demo supports transfers to saved payees and Apple share purchases. Try ‘Send SGD 100 to John Tan’ or ‘Buy one share of Apple’. No money has moved.",
      };
      if (error.code in demoMessages) return reply.code(200).send({ status: "SEMANTIC_VALIDATION_FAILED", message: demoMessages[error.code as keyof typeof demoMessages] });
      if (error.code === "EMPTY_INPUT") return reply.code(400).send({ code: "INVALID_REQUEST" });
      if (error.code === "MODEL_ERROR") return reply.code(503).send({ code: "INTERPRETER_UNAVAILABLE" });
      return reply.code(422).send({ code: "INTENT_INTERPRETATION_FAILED" });
    }
    const message = error instanceof Error ? error.message : "INTERNAL_ERROR";
    const safeCode = /^[A-Z][A-Z0-9_]*$/u.test(message) && !/^(?:INTERNAL_|OPS_TOKEN_|P\d|PRISMA_|SQL_|DATABASE_)/u.test(message) ? message : "INTERNAL_ERROR";
    const status = safeCode === "INTERNAL_ERROR" ? 500 : /NOT_FOUND/.test(safeCode) ? 404 : /(?:COMPILER|INTERPRETER)_UNAVAILABLE/.test(safeCode) || safeCode === "MOCK_BANK_UNAVAILABLE" ? 503 : 409;
    return reply.code(status).send({ code: safeCode });
  });
  void app.register(registerRoutes, { services, authorization }); return app;
}
