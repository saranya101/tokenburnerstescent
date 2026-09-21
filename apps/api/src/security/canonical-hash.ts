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

function canonicalDecimal(value: string): string {
  const [integer = "0", fraction] = value.split(".");
  const trimmedFraction = fraction?.replace(/0+$/, "");
  return trimmedFraction ? `${integer}.${trimmedFraction}` : integer === "-0" ? "0" : integer;
}

export function canonicalGoalContractJson(goal: GoalContractV1): string {
  const withoutHash = Object.fromEntries(Object.entries(goal).filter(([key]) => key !== "contractHash"));
  return canonicalJson({
    ...withoutHash,
    createdAt: new Date(goal.createdAt).toISOString(),
    ...(goal.confirmedAt === undefined ? {} : { confirmedAt: new Date(goal.confirmedAt).toISOString() }),
    entityBindings: goal.entityBindings.map((binding) => ({ ...binding, ...(binding.confidence === undefined ? {} : { confidence: canonicalDecimal(binding.confidence) }) })),
  });
}

export function hashGoalContract(goal: GoalContractV1): string {
  return createHash("sha256").update(canonicalGoalContractJson(goal)).digest("hex");
}

export function hashFinancialPlan(plan: FinancialPlanV1): string {
  return canonicalHash(Object.fromEntries(Object.entries(plan).filter(([key]) => key !== "planHash")));
}
