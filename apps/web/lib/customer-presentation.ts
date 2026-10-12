import type { BankStateSnapshotV1, FinancialPlanStepV1, FinancialPlanV1, GoalBundleContractV1, GoalContractV1, MoneyV1 } from "@parlance/contracts";

export type GoalDetail = { label: string; value: string };
export type GoalSummary = { eyebrow: string; title: string; description: string; details: GoalDetail[]; constraints: string[]; preferences: string[] };
export type PresentedPlanStep = { id: string; kind: string; title: string; summary: string; meta: Array<{ label: string; value: string }>; dependsOn?: string };
export type FundingItem = { account: string; amount: string; detail: string };
export type PlanPresentation = { goal: GoalSummary; planTitle: string; planSummary: string; steps: PresentedPlanStep[]; funding: FundingItem[]; preservedConstraints: string[]; acquiredAssets?: Array<{ assetId: string; asset: string; quantity: string }>; projectedBalances?: Array<{ account: string; amount: string }>; projectedHoldings?: Array<{ assetId: string; asset: string; quantity: string }>; validUntil?: string };
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

function authoritativeReferenceLabels(goal: Pick<GoalContractV1, "entityBindings">, state?: BankStateSnapshotV1): Map<string, string> {
  if (!state) return new Map();
  return new Map(goal.entityBindings.flatMap((binding): Array<[string, string]> => {
    if (binding.entityType === "BENEFICIARY") {
      const beneficiary = state.beneficiaries.find((candidate) => candidate.id === binding.entityId);
      return beneficiary ? [[binding.reference, beneficiary.name]] : [];
    }
    if (binding.entityType === "ASSET") {
      const asset = state.assets.find((candidate) => candidate.id === binding.entityId);
      return asset ? [[binding.reference, asset.name]] : [];
    }
    return [];
  }));
}
const named = (map: Map<string, string>, id: string, entityType: GoalContractV1["entityBindings"][number]["entityType"] | "ACCOUNT" = "ACCOUNT"): string => map.get(id) ?? customerName(id, undefined, entityType);

function addDecimalQuantities(left: string, right: string): string {
  const parts = (value: string) => { const [whole = "0", fraction = ""] = value.split("."); return { whole, fraction }; };
  const a = parts(left); const b = parts(right); const scale = Math.max(a.fraction.length, b.fraction.length);
  const units = (value: { whole: string; fraction: string }) => BigInt(`${value.whole}${value.fraction.padEnd(scale, "0")}`);
  const digits = (units(a) + units(b)).toString().padStart(scale + 1, "0");
  if (scale === 0) return digits;
  const fraction = digits.slice(-scale).replace(/0+$/u, "");
  return fraction.length === 0 ? digits.slice(0, -scale) : `${digits.slice(0, -scale)}.${fraction}`;
}

function convertedMinorUnits(sourceMinorUnits: string, rate: string): string | undefined {
  const match = /^(\d+)(?:\.(\d+))?$/u.exec(rate);
  if (!match) return undefined;
  const fraction = match[2] ?? ""; const denominator = 10n ** BigInt(fraction.length);
  const numerator = BigInt(`${match[1]}${fraction}`); const product = BigInt(sourceMinorUnits) * numerator;
  const quotient = product / denominator; const remainder = product % denominator; const doubled = remainder * 2n;
  return (doubled > denominator || (doubled === denominator && quotient % 2n !== 0n) ? quotient + 1n : quotient).toString();
}

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

function fxQuoteMeta(step: Extract<FinancialPlanStepV1, { action: "FX_CONVERT" }>, snapshot?: BankStateSnapshotV1): Array<{ label: string; value: string }> {
  const quote = snapshot?.fxQuotes.find((item) => item.id === step.parameters.quoteId);
  if (!quote) return [];
  return [
    { label: "Exchange rate", value: `1 ${quote.fromCurrency} = ${quote.rate} ${quote.toCurrency}` },
    { label: "Conversion fee", value: quote.fee ? formatMoney(quote.fee) : "No fee" },
    ...(convertedMinorUnits(step.parameters.sourceMoney.minorUnits, quote.rate) ? [{ label: `${quote.toCurrency} proceeds`, value: formatMoney({ currency: quote.toCurrency, minorUnits: convertedMinorUnits(step.parameters.sourceMoney.minorUnits, quote.rate)! }) }] : []),
  ];
}

function presentStep(step: FinancialPlanStepV1, map: Map<string, string>, snapshot?: BankStateSnapshotV1): PresentedPlanStep {
  const dependency = step.dependsOn.length ? step.dependsOn.join(", ") : undefined;
  if (step.action === "TRANSFER") return { id: step.id, kind: "Payment", title: `Send ${formatMoney(step.parameters.amount)}`, summary: `${named(map, step.parameters.sourceAccountId)} to ${named(map, step.parameters.beneficiaryId, "BENEFICIARY")}`, meta: [{ label: "From", value: named(map, step.parameters.sourceAccountId) }, { label: "To", value: named(map, step.parameters.beneficiaryId, "BENEFICIARY") }], ...(dependency ? { dependsOn: dependency } : {}) };
  if (step.action === "FX_CONVERT") return { id: step.id, kind: "Currency conversion", title: `Convert ${formatMoney(step.parameters.sourceMoney)} to ${step.parameters.targetCurrency}`, summary: `${named(map, step.parameters.sourceAccountId)} to ${named(map, step.parameters.destinationAccountId)}`, meta: [{ label: "From", value: named(map, step.parameters.sourceAccountId) }, { label: "To", value: named(map, step.parameters.destinationAccountId) }, ...fxQuoteMeta(step, snapshot)], ...(dependency ? { dependsOn: dependency } : {}) };
  if (step.action === "MOVE_FUNDS") return { id: step.id, kind: "Move", title: formatMoney(step.parameters.amount), summary: `${named(map, step.parameters.sourceAccountId)} → ${named(map, step.parameters.destinationAccountId)}`, meta: [{ label: "Source", value: named(map, step.parameters.sourceAccountId) }, { label: "Destination", value: named(map, step.parameters.destinationAccountId) }], ...(dependency ? { dependsOn: dependency } : {}) };
  if (step.action === "PAY_BILL") return { id: step.id, kind: "Payment", title: formatMoney(step.parameters.amount), summary: `${named(map, step.parameters.sourceAccountId)} → ${named(map, step.parameters.obligationId, "OBLIGATION")}`, meta: [{ label: "Obligation", value: named(map, step.parameters.obligationId, "OBLIGATION") }], ...(dependency ? { dependsOn: dependency } : {}) };
  if (step.action === "BUY_ASSET") {
    const settlementCurrency = step.parameters.settlementCurrency;
    return {
      id: step.id,
      kind: "Buy",
      title: `${step.parameters.quantity} ${named(map, step.parameters.assetId, "ASSET")}`,
      summary: `${named(map, step.parameters.sourceAccountId)} → Investment holding`,
      meta: [
        { label: "From", value: named(map, step.parameters.sourceAccountId) },
        { label: "Quantity", value: step.parameters.quantity },
        { label: "Unit price", value: formatMoney({ currency: settlementCurrency, minorUnits: step.parameters.quotedUnitPriceMinor }) },
        { label: "Fee", value: formatMoney({ currency: settlementCurrency, minorUnits: step.parameters.quotedFeeMinor }) },
        { label: "Total", value: formatMoney({ currency: settlementCurrency, minorUnits: step.parameters.authorizedTotalMinor }) },
      ],
      ...(dependency ? { dependsOn: dependency } : {}),
    };
  }
  return { id: step.id, kind: "Sell", title: `${step.parameters.quantity} ${named(map, step.parameters.assetId, "ASSET")}`, summary: `Investment holding → ${named(map, step.parameters.destinationAccountId)}`, meta: [{ label: "Quantity", value: step.parameters.quantity }], ...(dependency ? { dependsOn: dependency } : {}) };
}

export function presentPlan(goal: GoalContractV1, plan: FinancialPlanV1, liveState?: BankStateSnapshotV1): PlanPresentation {
  const referenceLabels = authoritativeReferenceLabels(goal, liveState);
  const map = names(goal, referenceLabels); const warnings = plan.projectedOutcome.warnings;
  const snapshot = liveState?.stateVersion === plan.bankStateVersion ? liveState : undefined;
  const funding = plan.steps.flatMap((step): FundingItem[] => {
    if (step.action !== "FX_CONVERT") return [];
    const quote = snapshot?.fxQuotes.find((item) => item.id === step.parameters.quoteId);
    const quoteDetail = quote ? `Rate 1 ${quote.fromCurrency} = ${quote.rate} ${quote.toCurrency}${quote.fee ? ` · fee ${formatMoney(quote.fee)}` : " · no fee"}` : `Converted to ${step.parameters.targetCurrency}`;
    return [{ account: named(map, step.parameters.sourceAccountId), amount: formatMoney(step.parameters.sourceMoney), detail: quoteDetail }];
  });
  return {
    goal: presentGoal(goal, referenceLabels), planTitle: goal.goal.type === "DELIVER_MONEY" ? "Review payment details" : goal.goal.type === "ACQUIRE_ASSET" ? "Review your investment" : "Review transaction details",
    planSummary: "Review how this transaction will be completed using your latest account information.",
    steps: plan.steps.map((step) => presentStep(step, map, snapshot)), funding,
    preservedConstraints: [...goal.constraints.map((item) => constraintText(item, map)), ...warnings],
    acquiredAssets: plan.projectedOutcome.acquiredAssets.map((item) => ({ assetId: item.assetId, asset: named(map, item.assetId, "ASSET"), quantity: item.quantity })),
    projectedBalances: plan.projectedOutcome.projectedAvailableBalances.map((item) => ({ account: named(map, item.accountId), amount: formatMoney(item.money) })),
    ...(plan.validity.validUntil ? { validUntil: plan.validity.validUntil } : {}),
    ...(snapshot === undefined ? {} : { projectedHoldings: plan.projectedOutcome.acquiredAssets.map((item) => ({
      assetId: item.assetId,
      asset: named(map, item.assetId, "ASSET"),
      quantity: addDecimalQuantities(snapshot.holdings.find((holding) => holding.assetId === item.assetId)?.quantity ?? "0", item.quantity),
    })) }),
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

export function presentBundlePlan(bundle: GoalBundleContractV1, plan: FinancialPlanV1, liveState?: BankStateSnapshotV1): PlanPresentation {
  const entityBindings = bundle.items.flatMap(({ bindings }) => bindings);
  const map = names({ entityBindings }); const warnings = plan.projectedOutcome.warnings; const summary = presentBundle(bundle);
  const funding = plan.steps.flatMap((step): FundingItem[] => step.action === "FX_CONVERT" ? [{ account: named(map, step.parameters.sourceAccountId), amount: formatMoney(step.parameters.sourceMoney), detail: `Converted to ${step.parameters.targetCurrency}` }] : []);
  return {
    goal: { eyebrow: "Combined request", title: `${bundle.items.length} requested actions`, description: summary.items.map((item) => `${item.ordered ? "Then " : ""}${item.text}`).join(" · "), details: [], constraints: summary.constraints, preferences: [] },
    planTitle: "Review combined transaction details", planSummary: "One plan covers every confirmed action in this request.",
    steps: plan.steps.map((step) => presentStep(step, map, liveState?.stateVersion === plan.bankStateVersion ? liveState : undefined)), funding,
    preservedConstraints: [...summary.constraints, ...warnings],
    projectedBalances: plan.projectedOutcome.projectedAvailableBalances.map((item) => ({ account: named(map, item.accountId), amount: formatMoney(item.money) })),
  };
}
