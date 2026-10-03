import type { FinancialPlanStepV1, FinancialPlanV1, GoalBundleContractV1, GoalContractV1, MoneyV1 } from "@parlance/contracts";

export type GoalDetail = { label: string; value: string };
export type GoalSummary = { eyebrow: string; title: string; description: string; details: GoalDetail[]; constraints: string[]; preferences: string[] };
export type PresentedPlanStep = { id: string; kind: string; title: string; summary: string; meta: Array<{ label: string; value: string }>; dependsOn?: string };
export type FundingItem = { account: string; amount: string; detail: string };
export type PlanPresentation = { goal: GoalSummary; planTitle: string; planSummary: string; steps: PresentedPlanStep[]; funding: FundingItem[]; preservedConstraints: string[] };
export type BundleSummary = { items: Array<{ itemId: string; text: string; ordered: boolean }>; constraints: string[] };

export function formatMoney(money: MoneyV1): string {
  const negative = money.minorUnits.startsWith("-"); const digits = negative ? money.minorUnits.slice(1) : money.minorUnits;
  let fractionDigits = 2;
  try { fractionDigits = new Intl.NumberFormat("en", { style: "currency", currency: money.currency }).resolvedOptions().maximumFractionDigits ?? 2; } catch { /* Currency code is still rendered without lossy coercion. */ }
  const padded = digits.padStart(fractionDigits + 1, "0"); const whole = (fractionDigits === 0 ? padded : padded.slice(0, -fractionDigits)).replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
  const fraction = fractionDigits === 0 ? "" : `.${padded.slice(-fractionDigits)}`;
  return `${money.currency} ${negative ? "-" : ""}${whole}${fraction}`;
}

const customerLabels: Readonly<Record<string, string>> = {
  "acc-sgd": "DBS Multiplier Account", "acc-usd": "USD Account", "acc-checking": "Everyday Account",
  "acc-savings": "Savings Account", "acc-brokerage": "Investment Account",
  "ben-ntu": "Nanyang Technological University", "asset-aapl": "Apple",
};

function safeFallback(entityType: GoalContractV1["entityBindings"][number]["entityType"] | "ACCOUNT"): string {
  if (entityType === "BENEFICIARY") return "Saved beneficiary";
  if (entityType === "ASSET") return "Selected investment";
  if (entityType === "BILLER" || entityType === "OBLIGATION") return "Selected biller";
  return "Selected account";
}

function customerName(id: string, reference: string | undefined, entityType: GoalContractV1["entityBindings"][number]["entityType"] | "ACCOUNT"): string {
  if (customerLabels[id]) return customerLabels[id];
  if (reference && !/^(?:acc|ben|asset|bill|obl)[-_]/iu.test(reference)) return reference;
  return safeFallback(entityType);
}

function names(goal: Pick<GoalContractV1, "entityBindings">, referenceLabels: ReadonlyMap<string, string> = new Map()): Map<string, string> {
  return new Map(goal.entityBindings.map((binding) => [binding.entityId, customerName(binding.entityId, referenceLabels.get(binding.reference) ?? binding.reference, binding.entityType)]));
}
const named = (map: Map<string, string>, id: string, entityType: GoalContractV1["entityBindings"][number]["entityType"] | "ACCOUNT" = "ACCOUNT"): string => map.get(id) ?? customerName(id, undefined, entityType);

function constraintText(constraint: GoalContractV1["constraints"][number], map: Map<string, string>): string {
  if (constraint.type === "MAX_TOTAL_COST") return `Spend no more than ${formatMoney(constraint.money)}`;
  if (constraint.type === "MIN_AVAILABLE_BALANCE") return `Keep at least ${formatMoney(constraint.money)}${constraint.accountId ? ` in ${named(map, constraint.accountId)}` : " available"}`;
  if (constraint.type === "EXCLUDED_ACCOUNT") return `Do not use ${named(map, constraint.accountId)}`;
  return `Maximum lock-in: ${constraint.days} days`;
}

function preferenceText(preference: GoalContractV1["preferences"][number], map: Map<string, string>): string {
  if (preference.type === "PREFER_ACCOUNT") return `Use ${named(map, preference.accountId)} for the remaining amount`;
  if (preference.type === "MINIMIZE_TOTAL_COST") return "Use the lowest-cost safe route";
  if (preference.type === "MINIMIZE_FX") return "Minimize currency conversion";
  return "Use the fastest safe route";
}

export function presentGoal(goal: Pick<GoalContractV1, "goal" | "constraints" | "preferences" | "entityBindings">, referenceLabels: ReadonlyMap<string, string> = new Map()): GoalSummary {
  const map = names(goal, referenceLabels); const details: GoalDetail[] = []; let eyebrow = "Your request"; let title = "Complete your financial goal"; let description = "Check what you asked us to do before continuing.";
  if (goal.goal.type === "DELIVER_MONEY") { const recipient = named(map, goal.goal.recipientId, "BENEFICIARY"); eyebrow = "Send money"; title = `Send ${formatMoney(goal.goal.amount)} to ${recipient}`; description = "Check the amount, recipient and any funding preference before continuing."; details.push({ label: "Amount", value: formatMoney(goal.goal.amount) }, { label: "To", value: recipient }); }
  if (goal.goal.type === "ACQUIRE_ASSET") { const asset = named(map, goal.goal.assetId, "ASSET"); eyebrow = "Buy an investment"; title = goal.goal.quantity ? `Buy ${goal.goal.quantity} ${asset} ${goal.goal.quantity === "1" ? "share" : "shares"}` : `Buy ${asset}`; description = "Check what you asked us to buy before continuing."; details.push({ label: "Investment", value: asset }); if (goal.goal.quantity) details.push({ label: "Quantity", value: goal.goal.quantity }); if (goal.goal.budget) details.push({ label: "Maximum spend", value: formatMoney(goal.goal.budget) }); }
  if (goal.goal.type === "PAY_BILL") { const biller = named(map, goal.goal.billerId, "BILLER"); eyebrow = "Pay a bill"; title = `Pay ${biller}`; description = "Check the biller and amount before continuing."; details.push({ label: "Biller", value: biller }); if (goal.goal.amount) details.push({ label: "Amount", value: formatMoney(goal.goal.amount) }); }
  if (goal.goal.type === "MOVE_FUNDS") { const destination = named(map, goal.goal.destinationAccountId); eyebrow = "Move money"; title = `Move ${formatMoney(goal.goal.amount)} to ${destination}`; description = "A transfer between your eligible accounts."; details.push({ label: "Destination", value: destination }, { label: "Amount", value: formatMoney(goal.goal.amount) }); if (goal.goal.sourceAccountId) details.push({ label: "Source", value: named(map, goal.goal.sourceAccountId) }); }
  return { eyebrow, title, description, details, constraints: goal.constraints.map((item) => constraintText(item, map)), preferences: goal.preferences.map((item) => preferenceText(item, map)) };
}

function presentStep(step: FinancialPlanStepV1, map: Map<string, string>): PresentedPlanStep {
  const dependency = step.dependsOn.length ? step.dependsOn.join(", ") : undefined;
  if (step.action === "TRANSFER") return { id: step.id, kind: "Payment", title: `Send ${formatMoney(step.parameters.amount)}`, summary: `${named(map, step.parameters.sourceAccountId)} to ${named(map, step.parameters.beneficiaryId, "BENEFICIARY")}`, meta: [{ label: "From", value: named(map, step.parameters.sourceAccountId) }, { label: "To", value: named(map, step.parameters.beneficiaryId, "BENEFICIARY") }], ...(dependency ? { dependsOn: dependency } : {}) };
  if (step.action === "FX_CONVERT") return { id: step.id, kind: "Currency conversion", title: `Convert ${formatMoney(step.parameters.sourceMoney)} to ${step.parameters.targetCurrency}`, summary: `${named(map, step.parameters.sourceAccountId)} to ${named(map, step.parameters.destinationAccountId)}`, meta: [{ label: "From", value: named(map, step.parameters.sourceAccountId) }, { label: "To", value: named(map, step.parameters.destinationAccountId) }], ...(dependency ? { dependsOn: dependency } : {}) };
  if (step.action === "MOVE_FUNDS") return { id: step.id, kind: "Move", title: formatMoney(step.parameters.amount), summary: `${named(map, step.parameters.sourceAccountId)} → ${named(map, step.parameters.destinationAccountId)}`, meta: [{ label: "Source", value: named(map, step.parameters.sourceAccountId) }, { label: "Destination", value: named(map, step.parameters.destinationAccountId) }], ...(dependency ? { dependsOn: dependency } : {}) };
  if (step.action === "PAY_BILL") return { id: step.id, kind: "Payment", title: formatMoney(step.parameters.amount), summary: `${named(map, step.parameters.sourceAccountId)} → ${named(map, step.parameters.obligationId, "OBLIGATION")}`, meta: [{ label: "Obligation", value: named(map, step.parameters.obligationId, "OBLIGATION") }], ...(dependency ? { dependsOn: dependency } : {}) };
  if (step.action === "BUY_ASSET") return { id: step.id, kind: "Buy", title: `${step.parameters.quantity} ${named(map, step.parameters.assetId, "ASSET")}`, summary: `${named(map, step.parameters.sourceAccountId)} → Investment holding`, meta: [{ label: "Maximum spend", value: formatMoney(step.parameters.maximumSpend) }, { label: "Quantity", value: step.parameters.quantity }], ...(dependency ? { dependsOn: dependency } : {}) };
  return { id: step.id, kind: "Sell", title: `${step.parameters.quantity} ${named(map, step.parameters.assetId, "ASSET")}`, summary: `Investment holding → ${named(map, step.parameters.destinationAccountId)}`, meta: [{ label: "Quantity", value: step.parameters.quantity }], ...(dependency ? { dependsOn: dependency } : {}) };
}

export function presentPlan(goal: GoalContractV1, plan: FinancialPlanV1): PlanPresentation {
  const map = names(goal); const warnings = plan.projectedOutcome.warnings;
  const funding = plan.steps.flatMap((step): FundingItem[] => step.action === "FX_CONVERT" ? [{ account: named(map, step.parameters.sourceAccountId), amount: formatMoney(step.parameters.sourceMoney), detail: `Converted to ${step.parameters.targetCurrency}` }] : []);
  return {
    goal: presentGoal(goal), planTitle: goal.goal.type === "DELIVER_MONEY" ? "Review payment details" : "Review transaction details",
    planSummary: "Review how this transaction will be completed using your latest account information.",
    steps: plan.steps.map((step) => presentStep(step, map)), funding,
    preservedConstraints: [...goal.constraints.map((item) => constraintText(item, map)), ...warnings],
  };
}

export function presentBundle(bundle: Pick<GoalBundleContractV1, "items" | "globalConstraints" | "explicitDependencies">): BundleSummary {
  const incoming = new Set(bundle.explicitDependencies.map(({ afterItemId }) => afterItemId));
  return {
    items: bundle.items.map((item) => {
      const summary = presentGoal({ goal: item.goal, constraints: item.constraints, preferences: item.preferences, entityBindings: item.bindings });
      return { itemId: item.itemId, text: summary.title, ordered: incoming.has(item.itemId) };
    }),
    constraints: bundle.globalConstraints.map((constraint) => constraintText(constraint, new Map())),
  };
}

export function presentBundlePlan(bundle: GoalBundleContractV1, plan: FinancialPlanV1): PlanPresentation {
  const entityBindings = bundle.items.flatMap(({ bindings }) => bindings);
  const map = names({ entityBindings }); const warnings = plan.projectedOutcome.warnings; const summary = presentBundle(bundle);
  const funding = plan.steps.flatMap((step): FundingItem[] => step.action === "FX_CONVERT" ? [{ account: named(map, step.parameters.sourceAccountId), amount: formatMoney(step.parameters.sourceMoney), detail: `Converted to ${step.parameters.targetCurrency}` }] : []);
  return {
    goal: { eyebrow: "Combined request", title: `${bundle.items.length} requested actions`, description: summary.items.map((item) => `${item.ordered ? "Then " : ""}${item.text}`).join(" · "), details: [], constraints: summary.constraints, preferences: [] },
    planTitle: "Review combined transaction details", planSummary: "One plan covers every confirmed action in this request.",
    steps: plan.steps.map((step) => presentStep(step, map)), funding,
    preservedConstraints: [...summary.constraints, ...warnings],
  };
}
