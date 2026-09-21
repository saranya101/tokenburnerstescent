import { createHash } from "node:crypto";
import type { FinancialPlanV1, GoalContractV1 } from "@parlance/contracts";

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, normalize(item)]));
  }
  return value;
}

export const canonicalJson = (value: unknown): string => JSON.stringify(normalize(value));
export const canonicalHash = (value: unknown): string => createHash("sha256").update(canonicalJson(value)).digest("hex");

export function hashGoalContract(goal: GoalContractV1): string {
  return canonicalHash(Object.fromEntries(Object.entries(goal).filter(([key]) => key !== "contractHash")));
}

export function hashFinancialPlan(plan: FinancialPlanV1): string {
  return canonicalHash(Object.fromEntries(Object.entries(plan).filter(([key]) => key !== "planHash")));
}
