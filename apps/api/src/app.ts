import Fastify from "fastify";
import { z } from "zod";
import { logger, resolveTraceId } from "@parlance/observability";
import { getPrismaClient } from "@parlance/db";
import { registerRoutes } from "./routes/index.js";
import { CompilerClient } from "./clients/compiler.js";
import { MockBankClient } from "./clients/mock-bank.js";
import { ApprovalService, CompilationService, ExecutionService } from "./orchestration/services.js";
import type { ParlanceRepository } from "./orchestration/ports.js";
import { PrismaParlanceRepository } from "./repositories/prisma.js";

export interface ApiServices { repository: ParlanceRepository; compilation: CompilationService; approval: ApprovalService; execution: ExecutionService }
export function productionServices(): ApiServices { const repository = new PrismaParlanceRepository(getPrismaClient()); const bank = new MockBankClient(); return { repository, compilation: new CompilationService(repository, bank, new CompilerClient()), approval: new ApprovalService(repository), execution: new ExecutionService(repository, bank) }; }
export function buildApp(services = productionServices()) {
  const app = Fastify({ loggerInstance: logger });
  app.addHook("onRequest", async (request, reply) => { const traceId = resolveTraceId(request.headers["x-trace-id"]); request.headers["x-trace-id"] = traceId; reply.header("x-trace-id", traceId); });
  app.get("/health", async () => ({ status: "ok", service: "api" }));
  app.get("/ready", async (_request, reply) => { const missing = ["DATABASE_URL", "DIRECT_URL", "COMPILER_URL", "MOCK_BANK_URL"].filter((key) => !process.env[key]); if (missing.length) return reply.code(503).send({ status: "not_ready", database: "not_checked", missing }); const databaseReady = await services.repository.isReady(); if (!databaseReady) return reply.code(503).send({ status: "not_ready", database: "unavailable" }); return { status: "ready", database: "ready" }; });
  app.setErrorHandler((error, _request, reply) => { const message = error instanceof Error ? error.message : "INTERNAL_ERROR"; const status = error instanceof z.ZodError ? 400 : /NOT_FOUND/.test(message) ? 404 : 409; return reply.code(status).send({ code: error instanceof z.ZodError ? "INVALID_REQUEST" : message, details: error instanceof z.ZodError ? error.issues : undefined }); });
  void app.register(registerRoutes, services); return app;
}
