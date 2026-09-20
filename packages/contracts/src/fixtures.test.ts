import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ApprovalV1, BankStateSnapshotV1, CompilerResultV1, ExecutionResultV1, FinancialPlanV1, GoalContractV1, HardRule, IntentDraftV1 } from "./index.js";

const fixturesRoot = join(process.cwd(), "fixtures");
const schemas = {
  "intent-draft.json": IntentDraftV1, "goal-contract.json": GoalContractV1, "bank-state.json": BankStateSnapshotV1,
  "financial-plan.json": FinancialPlanV1, "compiler-result.json": CompilerResultV1, "compiler-unsat.json": CompilerResultV1,
  "approval.json": ApprovalV1, "execution-result.json": ExecutionResultV1, "hard-rule.json": HardRule,
} as const;

function fixtureFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => { const path = join(directory, name); return statSync(path).isDirectory() ? fixtureFiles(path) : [path]; });
}

describe("Contract V1 fixtures", () => {
  for (const path of fixtureFiles(fixturesRoot)) {
    const name = path.split("/").at(-1) as keyof typeof schemas;
    it(`validates ${path.slice(fixturesRoot.length + 1)}`, () => {
      expect(schemas[name], `No schema registered for ${name}`).toBeDefined();
      expect(() => schemas[name].parse(JSON.parse(readFileSync(path, "utf8")))).not.toThrow();
    });
  }
});
