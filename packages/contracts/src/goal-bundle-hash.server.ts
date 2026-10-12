import { createHash } from "node:crypto";
import { canonicalGoalBundleJson, type GoalBundleContractV1 } from "./goal-bundle.js";

export function hashGoalBundleContract(bundle: GoalBundleContractV1): string {
  return createHash("sha256").update(canonicalGoalBundleJson(bundle)).digest("hex");
}
