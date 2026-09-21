import { BankStateSnapshotV1 } from "@parlance/contracts";
import { z } from "zod";
import type { BankWriteResult } from "../orchestration/ports.js";

const WriteResult = z.object({ accepted: z.literal(true), bankReference: z.string().min(1), stateVersion: z.number().int().nonnegative() }).strict();

export class MockBankClient {
  constructor(private readonly baseUrl = process.env.MOCK_BANK_URL ?? "http://localhost:4002") {}
  async getState(userId: string, traceId: string) {
    const response = await fetch(`${this.baseUrl}/v1/state/${encodeURIComponent(userId)}`, { headers: { "x-trace-id": traceId } });
    if (!response.ok) throw new Error(`Bank state unavailable: ${response.status}`);
    return BankStateSnapshotV1.parse(await response.json());
  }
  async execute(path: "fx" | "transfer" | "payment" | "buy", payload: unknown, idempotencyKey: string, traceId: string): Promise<BankWriteResult> {
    const response = await fetch(`${this.baseUrl}/v1/execute/${path}`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": idempotencyKey, "x-trace-id": traceId }, body: JSON.stringify(payload) });
    if (!response.ok) { const body = await response.json().catch(() => ({})) as { code?: string }; throw new Error(body.code ?? `BANK_WRITE_REJECTED_${response.status}`); }
    return WriteResult.parse(await response.json());
  }
}

export { MockBankClient as MockBankWriteClient };
