import { BankStateSnapshotV1, type CompilerResultV1, type FinancialPlanStepV1, type GoalContractV1 } from "@parlance/contracts";
import { canonicalJson } from "../security/canonical-hash.js";

export type RevalidationOutcome = "SAFE_TO_EXECUTE" | "STATE_CHANGED" | "REPLAN_REQUIRED" | "GOAL_NO_LONGER_ACHIEVABLE" | "POLICY_BLOCKED";

export type SimulationResult =
  | { outcome: "SAFE_TO_EXECUTE"; snapshot: BankStateSnapshotV1 }
  | { outcome: "POLICY_BLOCKED"; reason: string; explanation: string };

function updateBalance(snapshot: BankStateSnapshotV1, accountId: string, delta: bigint): BankStateSnapshotV1 | null {
  const account = snapshot.accounts.find((item) => item.id === accountId);
  if (!account || account.status !== "ACTIVE") return null;
  const available = BigInt(account.availableMinorUnits) + delta;
  const ledger = BigInt(account.ledgerMinorUnits) + delta;
  if (available < 0n || ledger < 0n) return null;
  return BankStateSnapshotV1.parse({
    ...snapshot,
    accounts: snapshot.accounts.map((item) => item.id === accountId
      ? { ...item, availableMinorUnits: available.toString(), ledgerMinorUnits: ledger.toString() }
      : item),
  });
}

function blocked(reason: string, explanation: string): SimulationResult {
  return { outcome: "POLICY_BLOCKED", reason, explanation };
}

function decimalParts(value: string): { numerator: bigint; scale: number } {
  const [integer, fraction = ""] = value.split(".");
  return { numerator: BigInt(`${integer}${fraction}`), scale: fraction.length };
}

function addDecimals(left: string, right: string): string {
  const a = decimalParts(left); const b = decimalParts(right); const scale = Math.max(a.scale, b.scale);
  const sum = a.numerator * 10n ** BigInt(scale - a.scale) + b.numerator * 10n ** BigInt(scale - b.scale);
  if (scale === 0) return sum.toString();
  const digits = sum.toString().padStart(scale + 1, "0"); const integer = digits.slice(0, -scale); const fraction = digits.slice(-scale).replace(/0+$/, "");
  return fraction ? `${integer}.${fraction}` : integer;
}

function multiplyMinorUnits(amount: string, rate: string): bigint {
  const parsed = decimalParts(rate); const denominator = 10n ** BigInt(parsed.scale); const product = BigInt(amount) * parsed.numerator;
  const quotient = product / denominator; const remainder = product % denominator; const doubled = remainder * 2n;
  return doubled > denominator || (doubled === denominator && quotient % 2n !== 0n) ? quotient + 1n : quotient;
}

function decimalEqual(left: string, right: string): boolean {
  const a = decimalParts(left); const b = decimalParts(right); const scale = Math.max(a.scale, b.scale);
  return a.numerator * 10n ** BigInt(scale - a.scale) === b.numerator * 10n ** BigInt(scale - b.scale);
}

function sourceAccountId(step: FinancialPlanStepV1): string | undefined {
  if (step.action === "FX_CONVERT") return step.parameters.sourceAccountId;
  if (step.action === "TRANSFER" || step.action === "MOVE_FUNDS" || step.action === "PAY_BILL" || step.action === "BUY_ASSET") return step.parameters.sourceAccountId;
  return undefined;
}

export function stepPreservesConstraints(goal: GoalContractV1, step: FinancialPlanStepV1, snapshot: BankStateSnapshotV1): boolean {
  return goal.constraints.every((constraint) => {
    if (constraint.type === "EXCLUDED_ACCOUNT") return sourceAccountId(step) !== constraint.accountId;
    // Contract V1.1 does not define which flows constitute total cost or cross-currency normalization.
    // Runtime enforcement therefore remains at the deterministic compiler/policy boundary.
    if (constraint.type === "MAX_TOTAL_COST") return false;
    if (constraint.type === "MIN_AVAILABLE_BALANCE") { const accounts = constraint.accountId ? snapshot.accounts.filter((item) => item.id === constraint.accountId) : snapshot.accounts.filter((item) => item.currency === constraint.money.currency && item.status === "ACTIVE"); return accounts.reduce((sum, account) => sum + BigInt(account.availableMinorUnits), 0n) >= BigInt(constraint.money.minorUnits); }
    return false;
  });
}

export function terminalStepSatisfiesGoal(goal: GoalContractV1, step: FinancialPlanStepV1, snapshot: BankStateSnapshotV1): boolean {
  if (!stepPreservesConstraints(goal, step, snapshot)) return false;
  if (goal.goal.type === "DELIVER_MONEY") return step.action === "TRANSFER" && step.parameters.beneficiaryId === goal.goal.recipientId && canonicalJson(step.parameters.amount) === canonicalJson(goal.goal.amount);
  if (goal.goal.type === "ACQUIRE_ASSET") return step.action === "BUY_ASSET" && step.parameters.assetId === goal.goal.assetId
    && (goal.goal.quantity === undefined || decimalEqual(step.parameters.quantity, goal.goal.quantity))
    && (goal.goal.budget === undefined || (step.parameters.maximumSpend.currency === goal.goal.budget.currency && BigInt(step.parameters.maximumSpend.minorUnits) <= BigInt(goal.goal.budget.minorUnits)));
  if (goal.goal.type === "PAY_BILL") return step.action === "PAY_BILL" && step.parameters.obligationId === goal.goal.billerId && (goal.goal.amount === undefined || canonicalJson(step.parameters.amount) === canonicalJson(goal.goal.amount));
  return step.action === "MOVE_FUNDS" && step.parameters.destinationAccountId === goal.goal.destinationAccountId && canonicalJson(step.parameters.amount) === canonicalJson(goal.goal.amount)
    && (goal.goal.sourceAccountId === undefined || step.parameters.sourceAccountId === goal.goal.sourceAccountId);
}

export function simulateFinancialStep(snapshot: BankStateSnapshotV1, step: FinancialPlanStepV1): SimulationResult {
  if (step.action === "FX_CONVERT") {
    if (!snapshot.serviceAvailability.fx) return blocked("FX_UNAVAILABLE", "Foreign-exchange service is currently unavailable.");
    const source = snapshot.accounts.find((item) => item.id === step.parameters.sourceAccountId);
    const destination = snapshot.accounts.find((item) => item.id === step.parameters.destinationAccountId);
    const quote = snapshot.fxQuotes.find((item) => item.id === step.parameters.quoteId);
    if (!source || source.status !== "ACTIVE" || source.currency !== step.parameters.sourceMoney.currency || !source.capabilities.includes("CONVERT_FX")) return blocked("FX_ACCOUNT_INELIGIBLE", "The approved source account can no longer perform this conversion.");
    if (!destination || destination.status !== "ACTIVE" || destination.id === source.id || destination.currency !== step.parameters.targetCurrency || !destination.capabilities.includes("RECEIVE_TRANSFER")) return blocked("FX_DESTINATION_ACCOUNT_NOT_FOUND", "The approved destination account can no longer receive this conversion.");
    if (!quote || quote.fromCurrency !== step.parameters.sourceMoney.currency || quote.toCurrency !== step.parameters.targetCurrency || Date.parse(quote.expiresAt) <= Date.parse(snapshot.capturedAt)) return blocked("FX_QUOTE_INVALID", "The approved foreign-exchange quote is no longer valid.");
    if (quote.fee && quote.fee.currency !== source.currency) return blocked("FX_FEE_CURRENCY_UNSUPPORTED", "The quote fee cannot be applied safely to the approved source account.");
    const debitMinorUnits = BigInt(step.parameters.sourceMoney.minorUnits) + BigInt(quote.fee?.minorUnits ?? "0");
    const debited = updateBalance(snapshot, source.id, -debitMinorUnits);
    if (!debited) return blocked("INSUFFICIENT_AVAILABLE_BALANCE", "The approved source account no longer has enough available funds.");
    const received = multiplyMinorUnits(step.parameters.sourceMoney.minorUnits, quote.rate);
    const credited = updateBalance(debited, step.parameters.destinationAccountId, received);
    return credited ? { outcome: "SAFE_TO_EXECUTE", snapshot: credited } : blocked("FX_SIMULATION_FAILED", "The conversion could not be simulated safely.");
  }

  if (step.action === "TRANSFER" || step.action === "MOVE_FUNDS" || step.action === "PAY_BILL") {
    const sourceAccountId = step.parameters.sourceAccountId;
    const amount = step.parameters.amount;
    if ((step.action === "TRANSFER" || step.action === "MOVE_FUNDS") && !snapshot.serviceAvailability.transfers) return blocked("TRANSFER_RAIL_UNAVAILABLE", "Transfers are currently unavailable.");
    if (step.action === "PAY_BILL" && !snapshot.serviceAvailability.billPayments) return blocked("BILL_PAYMENT_UNAVAILABLE", "Bill payments are currently unavailable.");
    const source = snapshot.accounts.find((item) => item.id === sourceAccountId);
    if (!source || source.currency !== amount.currency) return blocked("SOURCE_ACCOUNT_INELIGIBLE", "The approved source account is no longer eligible for this payment.");
    if ((step.action === "TRANSFER" || step.action === "MOVE_FUNDS") && !source.capabilities.includes("SEND_TRANSFER")) return blocked("TRANSFER_NOT_SUPPORTED", "The approved source account can no longer send transfers.");
    if (step.action === "TRANSFER") { const beneficiary = snapshot.beneficiaries.find((item) => item.id === step.parameters.beneficiaryId); if (!beneficiary || beneficiary.status !== "ACTIVE" || !beneficiary.supportedCurrencies.includes(amount.currency)) return blocked("BENEFICIARY_UNAVAILABLE", "The approved beneficiary can no longer receive this transfer."); }
    if (step.action === "PAY_BILL" && !source.capabilities.includes("PAY_BILL")) return blocked("BILL_PAYMENT_NOT_SUPPORTED", "The approved source account can no longer pay this bill.");
    const debited = updateBalance(snapshot, sourceAccountId, -BigInt(amount.minorUnits));
    if (!debited) return blocked("INSUFFICIENT_AVAILABLE_BALANCE", "The approved source account no longer has enough available funds.");
    if (step.action !== "MOVE_FUNDS") return { outcome: "SAFE_TO_EXECUTE", snapshot: debited };
    const destination = debited.accounts.find((item) => item.id === step.parameters.destinationAccountId);
    if (!destination || destination.currency !== amount.currency || !destination.capabilities.includes("RECEIVE_TRANSFER")) return blocked("DESTINATION_ACCOUNT_UNAVAILABLE", "The approved destination account is no longer available.");
    const credited = updateBalance(debited, step.parameters.destinationAccountId, BigInt(amount.minorUnits));
    return credited ? { outcome: "SAFE_TO_EXECUTE", snapshot: credited } : blocked("DESTINATION_ACCOUNT_UNAVAILABLE", "The approved destination account is no longer available.");
  }

  if (step.action === "BUY_ASSET") {
    if (!snapshot.serviceAvailability.investments) return blocked("ASSET_SERVICE_UNAVAILABLE", "Investment trading is currently unavailable.");
    const asset = snapshot.assets.find((item) => item.id === step.parameters.assetId);
    if (!asset?.tradable) return blocked("ASSET_UNAVAILABLE", "The approved asset is no longer available for trading.");
    const account = snapshot.accounts.find((item) => item.id === step.parameters.sourceAccountId);
    if (!account || asset.settlementCurrency !== account.currency || account.currency !== step.parameters.maximumSpend.currency || !account.capabilities.includes("TRADE_ASSET")) return blocked("INVESTMENT_ACCOUNT_INELIGIBLE", "The approved investment account or settlement currency is no longer eligible for this purchase.");
    const debited = updateBalance(snapshot, step.parameters.sourceAccountId, -BigInt(step.parameters.maximumSpend.minorUnits));
    if (!debited) return blocked("INSUFFICIENT_AVAILABLE_BALANCE", "The approved account no longer has enough available funds for this purchase.");
    const previous = debited.holdings.find((item) => item.assetId === step.parameters.assetId);
    const quantity = addDecimals(previous?.quantity ?? "0", step.parameters.quantity);
    return { outcome: "SAFE_TO_EXECUTE", snapshot: BankStateSnapshotV1.parse({ ...debited, holdings: [...debited.holdings.filter((item) => item.assetId !== step.parameters.assetId), { assetId: step.parameters.assetId, quantity }] }) };
  }

  return blocked("UNSUPPORTED_OPERATION", "This operation cannot be simulated safely.");
}

function materialStep(step: FinancialPlanStepV1): unknown {
  return { sequence: step.sequence, dependsOn: step.dependsOn, reversible: step.reversible, action: step.action, parameters: step.parameters };
}

export function materiallyEquivalentRoute(left: FinancialPlanStepV1[], right: FinancialPlanStepV1[]): boolean {
  return canonicalJson(left.map(materialStep)) === canonicalJson(right.map(materialStep));
}

export function assertCompilerBinding(result: CompilerResultV1, goalId: string, goalVersion: number, stateVersion: number): void {
  if (result.status === "SAT" && (result.plan.goalContractId !== goalId || result.plan.goalContractVersion !== goalVersion || result.plan.bankStateVersion !== stateVersion)) throw new Error("COMPILER_RESULT_BINDING_MISMATCH");
}
