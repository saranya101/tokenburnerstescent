import type { FinancialPlanStepV1, FinancialPlanV1, GoalContractV1, MoneyV1 } from "@parlance/contracts";

export type GoalDetail = { label: string; value: string };
export type GoalSummary = { eyebrow: string; title: string; description: string; details: GoalDetail[]; constraints: string[]; preferences: string[] };
export type PresentedPlanStep = { id: string; kind: string; title: string; summary: string; meta: Array<{ label: string; value: string }>; dependsOn?: string };
export type PlanPresentation = { goal: GoalSummary; planTitle: string; planSummary: string; steps: PresentedPlanStep[]; preservedConstraints: string[] };

export function formatMoney(money: MoneyV1): string {
  const negative = money.minorUnits.startsWith("-"); const digits = negative ? money.minorUnits.slice(1) : money.minorUnits;
  let fractionDigits = 2;
  try { fractionDigits = new Intl.NumberFormat("en", { style: "currency", currency: money.currency }).resolvedOptions().maximumFractionDigits ?? 2; } catch { /* Currency code is still rendered without lossy coercion. */ }
  const padded = digits.padStart(fractionDigits + 1, "0"); const whole = (fractionDigits === 0 ? padded : padded.slice(0, -fractionDigits)).replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
  const fraction = fractionDigits === 0 ? "" : `.${padded.slice(-fractionDigits)}`;
  return `${money.currency} ${negative ? "-" : ""}${whole}${fraction}`;
}

function names(goal: Pick<GoalContractV1, "entityBindings">): Map<string, string> {
  return new Map(goal.entityBindings.map((binding) => [binding.entityId, binding.reference]));
}
const named = (map: Map<string, string>, id: string): string => map.get(id) ?? id;

function constraintText(constraint: GoalContractV1["constraints"][number], map: Map<string, string>): string {
  if (constraint.type === "MAX_TOTAL_COST") return `Spend no more than ${formatMoney(constraint.money)}`;
  if (constraint.type === "MIN_AVAILABLE_BALANCE") return `Keep at least ${formatMoney(constraint.money)}${constraint.accountId ? ` in ${named(map, constraint.accountId)}` : " available"}`;
  if (constraint.type === "EXCLUDED_ACCOUNT") return `Do not use ${named(map, constraint.accountId)}`;
  return `Maximum lock-in: ${constraint.days} days`;
}

function preferenceText(preference: GoalContractV1["preferences"][number], map: Map<string, string>): string {
  if (preference.type === "PREFER_ACCOUNT") return `Prefer ${named(map, preference.accountId)}`;
  if (preference.type === "MINIMIZE_TOTAL_COST") return "Use the lowest-cost safe route";
  if (preference.type === "MINIMIZE_FX") return "Minimize currency conversion";
  return "Use the fastest safe route";
}

export function presentGoal(goal: Pick<GoalContractV1, "goal" | "constraints" | "preferences" | "entityBindings">): GoalSummary {
  const map = names(goal); const details: GoalDetail[] = []; let eyebrow = "Your request"; let title = "Complete your financial goal"; let description = "Parlance will ask banking systems to find a safe route.";
  if (goal.goal.type === "DELIVER_MONEY") { const recipient = named(map, goal.goal.recipientId); eyebrow = "Send money"; title = `Send ${formatMoney(goal.goal.amount)} to ${recipient}`; description = `A transfer to your confirmed ${recipient} beneficiary.`; details.push({ label: "Recipient", value: recipient }, { label: "Amount", value: formatMoney(goal.goal.amount) }); }
  if (goal.goal.type === "ACQUIRE_ASSET") { const asset = named(map, goal.goal.assetId); eyebrow = "Buy an asset"; title = `Buy ${asset}`; description = "A purchase using a route that remains inside your confirmed limits."; details.push({ label: "Asset", value: asset }); if (goal.goal.quantity) details.push({ label: "Quantity", value: goal.goal.quantity }); if (goal.goal.budget) details.push({ label: "Maximum spend", value: formatMoney(goal.goal.budget) }); }
  if (goal.goal.type === "PAY_BILL") { const biller = named(map, goal.goal.billerId); eyebrow = "Pay a bill"; title = `Pay ${biller}`; description = "A payment to your confirmed biller."; details.push({ label: "Biller", value: biller }); if (goal.goal.amount) details.push({ label: "Amount", value: formatMoney(goal.goal.amount) }); }
  if (goal.goal.type === "MOVE_FUNDS") { const destination = named(map, goal.goal.destinationAccountId); eyebrow = "Move money"; title = `Move ${formatMoney(goal.goal.amount)} to ${destination}`; description = "A transfer between your eligible accounts."; details.push({ label: "Destination", value: destination }, { label: "Amount", value: formatMoney(goal.goal.amount) }); if (goal.goal.sourceAccountId) details.push({ label: "Source", value: named(map, goal.goal.sourceAccountId) }); }
  return { eyebrow, title, description, details, constraints: goal.constraints.map((item) => constraintText(item, map)), preferences: goal.preferences.map((item) => preferenceText(item, map)) };
}

function presentStep(step: FinancialPlanStepV1, map: Map<string, string>): PresentedPlanStep {
  const dependency = step.dependsOn.length ? step.dependsOn.join(", ") : undefined;
  if (step.action === "TRANSFER") return { id: step.id, kind: "Transfer", title: `Send ${formatMoney(step.parameters.amount)}`, summary: `${named(map, step.parameters.sourceAccountId)} → ${named(map, step.parameters.beneficiaryId)}`, meta: [{ label: "Source", value: named(map, step.parameters.sourceAccountId) }, { label: "Recipient", value: named(map, step.parameters.beneficiaryId) }], ...(dependency ? { dependsOn: dependency } : {}) };
  if (step.action === "FX_CONVERT") return { id: step.id, kind: "Convert", title: `${formatMoney(step.parameters.sourceMoney)} → ${step.parameters.targetCurrency}`, summary: `${named(map, step.parameters.sourceAccountId)} → ${named(map, step.parameters.destinationAccountId)}`, meta: [{ label: "Quote", value: step.parameters.quoteId }, { label: "Target currency", value: step.parameters.targetCurrency }], ...(dependency ? { dependsOn: dependency } : {}) };
  if (step.action === "MOVE_FUNDS") return { id: step.id, kind: "Move", title: formatMoney(step.parameters.amount), summary: `${named(map, step.parameters.sourceAccountId)} → ${named(map, step.parameters.destinationAccountId)}`, meta: [{ label: "Source", value: named(map, step.parameters.sourceAccountId) }, { label: "Destination", value: named(map, step.parameters.destinationAccountId) }], ...(dependency ? { dependsOn: dependency } : {}) };
  if (step.action === "PAY_BILL") return { id: step.id, kind: "Payment", title: formatMoney(step.parameters.amount), summary: `${named(map, step.parameters.sourceAccountId)} → ${named(map, step.parameters.obligationId)}`, meta: [{ label: "Obligation", value: named(map, step.parameters.obligationId) }], ...(dependency ? { dependsOn: dependency } : {}) };
  if (step.action === "BUY_ASSET") return { id: step.id, kind: "Buy", title: `${step.parameters.quantity} ${named(map, step.parameters.assetId)}`, summary: `${named(map, step.parameters.sourceAccountId)} → Investment holding`, meta: [{ label: "Maximum spend", value: formatMoney(step.parameters.maximumSpend) }, { label: "Quantity", value: step.parameters.quantity }], ...(dependency ? { dependsOn: dependency } : {}) };
  return { id: step.id, kind: "Sell", title: `${step.parameters.quantity} ${named(map, step.parameters.assetId)}`, summary: `Investment holding → ${named(map, step.parameters.destinationAccountId)}`, meta: [{ label: "Quantity", value: step.parameters.quantity }], ...(dependency ? { dependsOn: dependency } : {}) };
}

export function presentPlan(goal: GoalContractV1, plan: FinancialPlanV1): PlanPresentation {
  const map = names(goal); const warnings = plan.projectedOutcome.warnings;
  return {
    goal: presentGoal(goal), planTitle: plan.steps.length === 1 ? "One safe step" : `${plan.steps.length} coordinated steps`,
    planSummary: "A safe route is available. Latest account state checked before this exact plan was created.",
    steps: plan.steps.map((step) => presentStep(step, map)),
    preservedConstraints: [...goal.constraints.map((item) => constraintText(item, map)), ...warnings],
  };
}
