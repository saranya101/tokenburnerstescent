import type { IntentDraftV1 } from "@parlance/contracts";

export const TOKENHUB_SMOKE_INPUT = "Get NTU US$5,000 without spending more than S$6,900 and don't touch Emergency Savings.";

export class TokenHubSemanticSmokeError extends Error {
  readonly name = "TokenHubSemanticSmokeError";
}

export function assertTokenHubSemanticSmokeDraft(draft: IntentDraftV1): void {
  const mismatches: string[] = [];

  if (draft.goal.type !== "ACQUIRE_ASSET") {
    mismatches.push(`goal.type expected ACQUIRE_ASSET, received ${draft.goal.type}`);
  } else {
    if (draft.goal.assetReference !== "NTU") mismatches.push(`goal.assetReference expected NTU, received ${draft.goal.assetReference}`);
    if (draft.goal.budget?.currency !== "USD") mismatches.push(`goal.budget.currency expected USD, received ${draft.goal.budget?.currency ?? "undefined"}`);
    if (draft.goal.budget?.minorUnits !== "500000") mismatches.push(`goal.budget.minorUnits expected 500000, received ${draft.goal.budget?.minorUnits ?? "undefined"}`);
  }

  const maxTotalCosts = draft.constraints.filter((constraint) => constraint.type === "MAX_TOTAL_COST");
  const excludedAccounts = draft.constraints.filter((constraint) => constraint.type === "EXCLUDED_ACCOUNT");
  if (maxTotalCosts.length !== 1) {
    mismatches.push(`constraints expected exactly one MAX_TOTAL_COST, received ${maxTotalCosts.length}`);
  } else if (maxTotalCosts[0]?.money.currency !== "SGD" || maxTotalCosts[0].money.minorUnits !== "690000") {
    mismatches.push("constraints expected MAX_TOTAL_COST with SGD 690000");
  }
  if (excludedAccounts.length !== 1) {
    mismatches.push(`constraints expected exactly one EXCLUDED_ACCOUNT, received ${excludedAccounts.length}`);
  } else if (excludedAccounts[0]?.accountReference !== "Emergency Savings") {
    mismatches.push("constraints expected EXCLUDED_ACCOUNT for Emergency Savings");
  }
  if (draft.constraints.some((constraint) => constraint.type === "MAX_LOCK_IN_DAYS")) {
    mismatches.push("constraints must not contain MAX_LOCK_IN_DAYS");
  }
  if (draft.constraints.some((constraint) => constraint.type === "MIN_AVAILABLE_BALANCE")) {
    mismatches.push("constraints must not contain MIN_AVAILABLE_BALANCE");
  }
  if (draft.constraints.length !== 2) mismatches.push(`constraints expected total length 2, received ${draft.constraints.length}`);

  if (mismatches.length > 0) throw new TokenHubSemanticSmokeError(mismatches.join("; "));
}
