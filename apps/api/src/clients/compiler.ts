import { CompilerResultV1, type BankStateSnapshotV1, type GoalContractV1 } from "@parlance/contracts";
import { logger } from "@parlance/observability";
export class CompilerClient {
  constructor(private readonly baseUrl = process.env.COMPILER_URL ?? "http://localhost:8001") {}
  async isReady(traceId: string): Promise<boolean> {
    try { return (await fetch(`${this.baseUrl}/ready`, { headers: { "x-trace-id": traceId } })).ok; }
    catch (error) { logger.warn({ err: error, dependency: "compiler", traceId }, "dependency readiness check failed"); return false; }
  }
  async compile(goal: GoalContractV1, state: BankStateSnapshotV1, traceId: string) {
    let response: Response;
    try { response = await fetch(`${this.baseUrl}/v1/compile`, { method: "POST", headers: { "content-type": "application/json", "x-trace-id": traceId }, body: JSON.stringify({ goalContract: goal, bankStateSnapshot: state }) }); }
    catch (error) { logger.error({ err: error, dependency: "compiler", traceId }, "dependency request failed"); throw new Error("COMPILER_UNAVAILABLE"); }
    if (!response.ok) { logger.error({ dependency: "compiler", traceId, statusCode: response.status }, "dependency returned an error"); throw new Error("COMPILER_UNAVAILABLE"); }
    const value = await response.json() as { status?: unknown; plan?: { validity?: { validUntil?: unknown } } };
    if (value.status === "SAT" && value.plan?.validity?.validUntil === null) delete value.plan.validity.validUntil;
    return CompilerResultV1.parse(value);
  }
}
