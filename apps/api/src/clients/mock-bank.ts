export class MockBankWriteClient {
  constructor(private readonly baseUrl = process.env.MOCK_BANK_URL ?? "http://localhost:4002") {}
  async execute(path: "fx" | "transfer" | "payment" | "buy", payload: unknown, idempotencyKey: string, traceId: string): Promise<unknown> {
    const response = await fetch(`${this.baseUrl}/v1/execute/${path}`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": idempotencyKey, "x-trace-id": traceId }, body: JSON.stringify(payload) });
    if (!response.ok) throw new Error(`Bank write rejected: ${response.status}`); return response.json();
  }
}
