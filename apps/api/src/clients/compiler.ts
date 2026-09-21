import { CompilerResultV1, type BankStateSnapshotV1, type GoalContractV1 } from "@parlance/contracts";
export class CompilerClient {
  constructor(private readonly baseUrl = process.env.COMPILER_URL ?? "http://localhost:8001") {}
  async compile(goal: GoalContractV1, state: BankStateSnapshotV1, traceId: string) {
    const response = await fetch(`${this.baseUrl}/v1/compile`, { method: "POST", headers: { "content-type": "application/json", "x-trace-id": traceId }, body: JSON.stringify({ goalContract: goal, bankStateSnapshot: state }) });
    if (!response.ok) throw new Error(`Compiler unavailable: ${response.status}`);
    return CompilerResultV1.parse(await response.json());
  }
}
