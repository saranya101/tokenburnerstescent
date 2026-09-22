import { BankStateSnapshotV1 } from "@parlance/contracts";
import { logger } from "@parlance/observability";
import { z } from "zod";
import type { BankWriteResult } from "../orchestration/ports.js";

const WriteResult = z.object({ accepted: z.literal(true), bankReference: z.string().min(1), stateVersion: z.number().int().nonnegative() }).strict();

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
    catch (error) { logger.error({ err: error, dependency: "mock-bank", traceId }, "dependency request failed"); throw new Error("MOCK_BANK_UNAVAILABLE"); }
    if (!response.ok) { const body = await response.json().catch(() => ({})) as { code?: string }; throw new Error(body.code ?? `BANK_WRITE_REJECTED_${response.status}`); }
    return WriteResult.parse(await response.json());
  }
}

export { MockBankClient as MockBankWriteClient };
