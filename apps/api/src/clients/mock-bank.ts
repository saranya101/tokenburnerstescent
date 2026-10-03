import { BankStateSnapshotV1 } from "@parlance/contracts";
import { logger } from "@parlance/observability";
import { z } from "zod";
import { BankOutcomeUnknownError, type BankLookupResult, type BankWriteResult } from "../orchestration/ports.js";

const WriteResult = z.object({ accepted: z.literal(true), bankReference: z.string().min(1), stateVersion: z.number().int().nonnegative() }).strict();
const LookupResult = z.discriminatedUnion("status", [
  z.object({ status: z.literal("NOT_FOUND"), idempotencyKey: z.string().min(1) }).strict(),
  z.object({ status: z.literal("COMPLETED"), idempotencyKey: z.string().min(1), operation: z.enum(["fx", "transfer", "payment", "buy"]), requestHash: z.string().regex(/^[a-f0-9]{64}$/u), accepted: z.literal(true), bankReference: z.string().min(1), stateVersion: z.number().int().nonnegative() }).strict(),
]);
const DEFINITE_PRE_MUTATION_REJECTIONS = new Set(["FX_UNAVAILABLE", "TRANSFER_RAIL_UNAVAILABLE", "ASSET_UNAVAILABLE", "QUOTE_EXPIRED", "BALANCE_CHANGED", "ACCOUNT_NOT_FOUND", "INSUFFICIENT_FUNDS", "FX_DESTINATION_ACCOUNT_NOT_FOUND", "IDEMPOTENCY_KEY_REUSED"]);

export class MockBankClient {
  constructor(private readonly baseUrl = process.env.MOCK_BANK_URL ?? "http://localhost:4002") {}
  async isReady(traceId: string): Promise<boolean> {
    try { return (await fetch(`${this.baseUrl}/ready`, { headers: { "x-trace-id": traceId } })).ok; }
    catch (error) { logger.warn({ err: error, dependency: "mock-bank", traceId }, "dependency readiness check failed"); return false; }
  }
  async getState(userId: string, traceId: string) {
    let response: Response;
    try { response = await fetch(`${this.baseUrl}/v1/state/${encodeURIComponent(userId)}`, { headers: { "x-trace-id": traceId } }); }
    catch (error) { logger.error({ err: error, dependency: "mock-bank", traceId }, "dependency request failed"); throw new Error("MOCK_BANK_UNAVAILABLE"); }
    if (!response.ok) { logger.error({ dependency: "mock-bank", traceId, statusCode: response.status }, "dependency returned an error"); throw new Error("MOCK_BANK_UNAVAILABLE"); }
    return BankStateSnapshotV1.parse(await response.json());
  }
  async execute(path: "fx" | "transfer" | "payment" | "buy", payload: unknown, idempotencyKey: string, traceId: string): Promise<BankWriteResult> {
    let response: Response;
    try { response = await fetch(`${this.baseUrl}/v1/execute/${path}`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": idempotencyKey, "x-trace-id": traceId }, body: JSON.stringify(payload) }); }
    catch (error) { logger.error({ err: error, dependency: "mock-bank", traceId }, "bank write response outcome unknown"); throw new BankOutcomeUnknownError(); }
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { code?: string };
      if (response.status >= 500 && (!body.code || !DEFINITE_PRE_MUTATION_REJECTIONS.has(body.code))) { logger.error({ dependency: "mock-bank", traceId, statusCode: response.status }, "bank write response outcome unknown"); throw new BankOutcomeUnknownError(); }
      throw new Error(body.code ?? `BANK_WRITE_REJECTED_${response.status}`);
    }
    try { return WriteResult.parse(await response.json()); }
    catch (error) { logger.error({ err: error, dependency: "mock-bank", traceId }, "bank write response could not be verified"); throw new BankOutcomeUnknownError(); }
  }
  async lookupByIdempotencyKey(idempotencyKey: string, traceId: string): Promise<BankLookupResult> {
    let response: Response;
    try { response = await fetch(`${this.baseUrl}/v1/executions/idempotency/${encodeURIComponent(idempotencyKey)}`, { headers: { "x-trace-id": traceId } }); }
    catch (error) { logger.error({ err: error, dependency: "mock-bank", traceId }, "bank idempotency lookup unavailable"); throw new Error("BANK_LOOKUP_UNAVAILABLE"); }
    if (!response.ok) { logger.error({ dependency: "mock-bank", traceId, statusCode: response.status }, "bank idempotency lookup returned an error"); throw new Error("BANK_LOOKUP_UNAVAILABLE"); }
    try { return LookupResult.parse(await response.json()); }
    catch (error) { logger.error({ err: error, dependency: "mock-bank", traceId }, "bank idempotency lookup response invalid"); throw new Error("BANK_LOOKUP_UNAVAILABLE"); }
  }
}

export { MockBankClient as MockBankWriteClient };
