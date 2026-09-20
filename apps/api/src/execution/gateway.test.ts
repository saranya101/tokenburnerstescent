import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ApprovalV1, FinancialPlanV1, GoalContractV1 } from "@parlance/contracts";
import { expect, it } from "vitest";
import { verifyExecutionAuthorization } from "./gateway.js";

const fixture = (name: string): unknown => JSON.parse(readFileSync(join(process.cwd(), "../../packages/contracts/fixtures/01-ntu-transfer", name), "utf8"));

it("rejects stale state without revalidation", () => expect(() => verifyExecutionAuthorization({
  goal: GoalContractV1.parse(fixture("goal-contract.json")), plan: FinancialPlanV1.parse(fixture("financial-plan.json")),
  approval: { ...ApprovalV1.parse(fixture("approval.json")), expiresAt: new Date(Date.now() + 60_000).toISOString() }, currentStateVersion: 8, revalidated: false,
  executionState: "AUTHORIZED", idempotencyKey: "k",
})).toThrow(/stale/));
