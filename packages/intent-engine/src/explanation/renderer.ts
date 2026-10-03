import {
  CompilerResultV1,
  ExecutionResultV1,
  FinancialPlanV1,
  GoalContractV1,
  type FinancialPlanStepV1,
  type MoneyV1,
} from "@parlance/contracts";
import { ExplanationInputError } from "./errors.js";
import { GoalContractCandidateV1 } from "../goal-contract/types.js";
import type {
  DeterministicExplanationV1,
  ExplanationInput,
  ExplanationRenderer,
  ExplanationStatement,
} from "./types.js";

type Goal = GoalContractV1;
type GoalSummary = Pick<Goal, "schemaVersion" | "goal" | "constraints" | "preferences" | "entityBindings">;
type Plan = FinancialPlanV1;

/** Pure, provider-independent rendering from validated deterministic contracts. */
export class DeterministicExplanationRenderer implements ExplanationRenderer {
  explain(input: ExplanationInput): DeterministicExplanationV1 {
    switch (input.subject) {
      case "GOAL":
        return explainGoal(
          "id" in input.goal
            ? GoalContractV1.parse(input.goal)
            : GoalContractCandidateV1.parse(input.goal)
        );
      case "PLAN": {
        const plan = FinancialPlanV1.parse(input.plan);
        const goal = input.goal === undefined ? undefined : GoalContractV1.parse(input.goal);
        return explainPlan(plan, goal, "PLAN_SUMMARY");
      }
      case "COMPILER_RESULT": {
        const result = CompilerResultV1.parse(input.result);
        const goal = input.goal === undefined ? undefined : GoalContractV1.parse(input.goal);
        if (result.status === "SAT") return explainPlan(result.plan, goal, "COMPILER_SAT");
        if (result.status === "UNSAT") {
          const internalReferences = compilerInternalReferences(result.reason.details, goal);
          return {
            schemaVersion: "1",
            kind: "COMPILER_UNSAT",
            title: "No feasible plan was found",
            statements: [
              statement("REASON", redactInternalReferences(result.reason.message, internalReferences), "compiler.reason"),
              ...result.relaxations.map((relaxation, index) =>
                statement("RELAXATION", `Compiler-provided option: ${redactInternalReferences(relaxation.suggestion, internalReferences)}`, "compiler.relaxations", index)
              ),
            ],
          };
        }
        const internalReferences = compilerInternalReferences(result.reason.details, goal);
        return {
          schemaVersion: "1",
          kind: "POLICY_BLOCKED",
          title: "The request is blocked by policy",
          statements: [statement("REASON", redactInternalReferences(result.reason.message, internalReferences), "compiler.reason")],
        };
      }
      case "EXECUTION_RESULT":
        return explainExecution(ExecutionResultV1.parse(input.result));
    }
  }
}

export function renderExplanationText(explanation: DeterministicExplanationV1): string {
  return [explanation.title, ...explanation.statements.map(({ text }) => text)].join("\n");
}

function explainGoal(goal: GoalSummary): DeterministicExplanationV1 {
  const labels = entityLabels(goal);
  const statements: ExplanationStatement[] = [
    statement("GOAL", goalText(goal, labels), "goal"),
    ...goal.constraints.map((constraint, index) =>
      statement("CONSTRAINT", constraintText(constraint, labels), "constraints", index)
    ),
    ...goal.preferences.map((preference, index) =>
      statement("PREFERENCE", preferenceText(preference, labels), "preferences", index)
    ),
  ];
  return { schemaVersion: "1", kind: "GOAL_SUMMARY", title: "Goal summary", statements };
}

function explainPlan(plan: Plan, goal: Goal | undefined, kind: "PLAN_SUMMARY" | "COMPILER_SAT"): DeterministicExplanationV1 {
  if (goal !== undefined && (plan.goalContractId !== goal.id || plan.goalContractVersion !== goal.version)) {
    throw new ExplanationInputError("The supplied goal does not match the financial plan.");
  }
  const labels = goal === undefined ? new Map<string, string>() : entityLabels(goal);
  const statements: ExplanationStatement[] = [
    statement(
      "PLAN_STATUS",
      `This is a proposed ${plan.steps.length}-step plan. No execution result was supplied, so this explanation does not say that any step has executed.`,
      "plan",
    ),
    ...plan.steps.map((step, index) => ({
      ...statement("PLAN_STEP", `Step ${index + 1}: ${planStepText(step, labels)}`, "plan.steps", index),
      operation: step.action,
    })),
    statement(
      "PROJECTED_OUTCOME",
      plan.projectedOutcome.goalSatisfied
        ? "The compiler projects that the proposed plan will satisfy the goal."
        : "The compiler does not project that the proposed plan will satisfy the goal.",
      "plan",
    ),
  ];
  if (plan.validity.validUntil !== undefined) {
    statements.push(statement("PLAN_STATUS", `The proposed plan is valid until ${plan.validity.validUntil}.`, "plan"));
  }
  return {
    schemaVersion: "1",
    kind,
    title: kind === "COMPILER_SAT" ? "The compiler found a proposed plan" : "Proposed plan summary",
    statements,
  };
}

function explainExecution(result: ExecutionResultV1): DeterministicExplanationV1 {
  const statusText = {
    PENDING: "Execution is pending.",
    EXECUTING: "Execution is in progress.",
    COMPLETED: "Execution completed.",
    FAILED: "Execution failed.",
    UNKNOWN: "Execution status is unknown.",
  }[result.status];
  const statements: ExplanationStatement[] = [
    statement("EXECUTION_STATUS", statusText, "execution"),
    ...result.steps.map((step, index) =>
      statement("EXECUTION_STEP", `Execution step ${index + 1} status: ${step.status}.`, "execution.steps", index)
    ),
    statement(
      "EXECUTION_OUTCOME",
      result.goalOutcome.achieved
        ? "The execution result records the goal as achieved."
        : "The execution result does not record the goal as achieved.",
      "execution.goalOutcome",
    ),
  ];
  if (result.goalOutcome.deliveredMoney !== undefined) {
    statements.push(statement(
      "EXECUTION_OUTCOME",
      `The recorded delivered amount is ${formatMoney(result.goalOutcome.deliveredMoney)}.`,
      "execution.goalOutcome",
    ));
  }
  if (result.goalOutcome.acquiredAsset !== undefined) {
    statements.push(statement(
      "EXECUTION_OUTCOME",
      `The recorded acquired quantity is ${result.goalOutcome.acquiredAsset.quantity}.`,
      "execution.goalOutcome",
    ));
  }
  return { schemaVersion: "1", kind: "EXECUTION_RESULT", title: "Execution result", statements };
}

function goalText(goal: GoalSummary, labels: ReadonlyMap<string, string>): string {
  switch (goal.goal.type) {
    case "DELIVER_MONEY":
      return `Deliver ${formatMoney(goal.goal.amount)} to ${labelFor(labels, goal.goal.recipientId, "the selected recipient")}.`;
    case "ACQUIRE_ASSET": {
      const target = labelFor(labels, goal.goal.assetId, "the selected asset");
      const terms = [
        ...(goal.goal.quantity === undefined ? [] : [`quantity ${goal.goal.quantity}`]),
        ...(goal.goal.budget === undefined ? [] : [`a budget of ${formatMoney(goal.goal.budget)}`]),
      ];
      return `Acquire ${target} with ${joinTerms(terms)}.`;
    }
    case "PAY_BILL":
      return goal.goal.amount === undefined
        ? `Pay ${labelFor(labels, goal.goal.billerId, "the selected biller")}.`
        : `Pay ${formatMoney(goal.goal.amount)} to ${labelFor(labels, goal.goal.billerId, "the selected biller")}.`;
    case "MOVE_FUNDS": {
      const source = goal.goal.sourceAccountId === undefined
        ? "a source account"
        : labelFor(labels, goal.goal.sourceAccountId, "the selected source account");
      return `Move ${formatMoney(goal.goal.amount)} from ${source} to ${labelFor(labels, goal.goal.destinationAccountId, "the selected destination account")}.`;
    }
  }
}

function constraintText(constraint: GoalSummary["constraints"][number], labels: ReadonlyMap<string, string>): string {
  switch (constraint.type) {
    case "MAX_TOTAL_COST":
      return `Keep the total cost at or below ${formatMoney(constraint.money)}.`;
    case "MIN_AVAILABLE_BALANCE":
      return constraint.accountId === undefined
        ? `Keep at least ${formatMoney(constraint.money)} available.`
        : `Keep at least ${formatMoney(constraint.money)} available in ${labelFor(labels, constraint.accountId, "the selected account")}.`;
    case "EXCLUDED_ACCOUNT":
      return `Do not use ${labelFor(labels, constraint.accountId, "the excluded account")}.`;
    case "MAX_LOCK_IN_DAYS":
      return `Keep the lock-in period at or below ${constraint.days} days.`;
  }
}

function preferenceText(preference: GoalSummary["preferences"][number], labels: ReadonlyMap<string, string>): string {
  switch (preference.type) {
    case "MINIMIZE_TOTAL_COST": return "Prefer a lower total cost when feasible.";
    case "MINIMIZE_FX": return "Prefer less foreign-exchange conversion when feasible.";
    case "FASTEST": return "Prefer the fastest feasible option.";
    case "PREFER_ACCOUNT": return `Prefer ${labelFor(labels, preference.accountId, "the selected account")} when feasible.`;
  }
}

function planStepText(step: FinancialPlanStepV1, labels: ReadonlyMap<string, string>): string {
  switch (step.action) {
    case "TRANSFER":
      return `Transfer ${formatMoney(step.parameters.amount)} from ${labelFor(labels, step.parameters.sourceAccountId, "a source account")} to ${labelFor(labels, step.parameters.beneficiaryId, "the selected recipient")}.`;
    case "FX_CONVERT":
      return `Convert ${formatMoney(step.parameters.sourceMoney)} from ${labelFor(labels, step.parameters.sourceAccountId, "a source account")} into ${step.parameters.targetCurrency} for ${labelFor(labels, step.parameters.destinationAccountId, "a destination account")}.`;
    case "MOVE_FUNDS":
      return `Move ${formatMoney(step.parameters.amount)} from ${labelFor(labels, step.parameters.sourceAccountId, "a source account")} to ${labelFor(labels, step.parameters.destinationAccountId, "a destination account")}.`;
    case "PAY_BILL":
      return `Pay ${formatMoney(step.parameters.amount)} from ${labelFor(labels, step.parameters.sourceAccountId, "a source account")} toward ${labelFor(labels, step.parameters.obligationId, "the selected bill")}.`;
    case "BUY_ASSET":
      return `Buy quantity ${step.parameters.quantity} of ${labelFor(labels, step.parameters.assetId, "the selected asset")} from ${labelFor(labels, step.parameters.sourceAccountId, "a source account")}, spending no more than ${formatMoney(step.parameters.maximumSpend)}.`;
    case "SELL_ASSET":
      return `Sell quantity ${step.parameters.quantity} of ${labelFor(labels, step.parameters.assetId, "the selected asset")} into ${labelFor(labels, step.parameters.destinationAccountId, "a destination account")}.`;
  }
}

function entityLabels(goal: GoalSummary): ReadonlyMap<string, string> {
  const labels = new Map<string, string>();
  const conflicts = new Set<string>();
  for (const binding of goal.entityBindings) {
    const existing = labels.get(binding.entityId);
    if (existing === undefined && !conflicts.has(binding.entityId)) labels.set(binding.entityId, binding.reference);
    else if (existing !== binding.reference) {
      labels.delete(binding.entityId);
      conflicts.add(binding.entityId);
    }
  }
  return labels;
}

function labelFor(labels: ReadonlyMap<string, string>, id: string, fallback: string): string {
  return labels.get(id) ?? fallback;
}

function joinTerms(terms: readonly string[]): string {
  return terms.length === 2 ? `${terms[0]} and ${terms[1]}` : terms[0] ?? "the supplied acquisition terms";
}

function formatMoney(money: MoneyV1): string {
  if (money.currency !== "USD" && money.currency !== "SGD") {
    return `${money.currency} ${money.minorUnits} minor units`;
  }
  const negative = money.minorUnits.startsWith("-");
  const digits = (negative ? money.minorUnits.slice(1) : money.minorUnits).padStart(3, "0");
  const whole = digits.slice(0, -2);
  const fraction = digits.slice(-2);
  return `${money.currency} ${negative ? "-" : ""}${groupDigits(whole)}.${fraction}`;
}

function groupDigits(value: string): string {
  return value.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Compiler prose is authoritative, but internal identifiers are not user-facing facts. */
function redactInternalReferences(text: string, internalReferences: ReadonlySet<string>): string {
  let safe = text;
  for (const value of [...internalReferences].sort((left, right) => right.length - left.length)) {
    if (value.length > 0) safe = safe.split(value).join("[internal reference]");
  }
  return safe
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, "[internal reference]")
    .replace(/\b(?:acc|account|asset|ben|beneficiary|biller|entity|obligation|recipient|goal|plan|execution|exec|quote|step)_[a-z0-9][a-z0-9_-]*\b/gi, "[internal reference]")
    .replace(/\b(?:acc|ben|biller|entity|obligation|recipient|goal|plan|execution|exec|quote|step)-[a-z0-9][a-z0-9_-]*\b/gi, "[internal reference]");
}

function compilerInternalReferences(details: Readonly<Record<string, unknown>> | undefined, goal: Goal | undefined): ReadonlySet<string> {
  const values = new Set<string>();
  if (goal !== undefined) {
    addInternalReference(values, goal.id);
    addInternalReference(values, goal.userId);
    addInternalReference(values, goal.sourceIntentDraftId);
    addInternalReference(values, goal.contractHash);
    for (const binding of goal.entityBindings) addInternalReference(values, binding.entityId);
    switch (goal.goal.type) {
      case "DELIVER_MONEY": addInternalReference(values, goal.goal.recipientId); break;
      case "ACQUIRE_ASSET": addInternalReference(values, goal.goal.assetId); break;
      case "PAY_BILL": addInternalReference(values, goal.goal.billerId); break;
      case "MOVE_FUNDS":
        addInternalReference(values, goal.goal.sourceAccountId);
        addInternalReference(values, goal.goal.destinationAccountId);
        break;
    }
    for (const constraint of goal.constraints) {
      if (constraint.type === "EXCLUDED_ACCOUNT" || constraint.type === "MIN_AVAILABLE_BALANCE") {
        addInternalReference(values, constraint.accountId);
      }
    }
    for (const preference of goal.preferences) {
      if (preference.type === "PREFER_ACCOUNT") addInternalReference(values, preference.accountId);
    }
  }
  collectInternalDetailValues(details, undefined, values);
  return values;
}

function collectInternalDetailValues(value: unknown, key: string | undefined, values: Set<string>): void {
  if (typeof value === "string") {
    if (key !== undefined && /(?:id|ids|hash|providerRef|bankReference)$/i.test(key)) addInternalReference(values, value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectInternalDetailValues(item, key, values);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [nestedKey, nestedValue] of Object.entries(value)) {
    collectInternalDetailValues(nestedValue, nestedKey, values);
  }
}

function addInternalReference(values: Set<string>, value: string | undefined): void {
  if (value !== undefined && value.length > 0) values.add(value);
}

function statement(
  kind: ExplanationStatement["kind"],
  text: string,
  sourceSection: ExplanationStatement["sourceSection"],
  sourceIndex?: number,
): ExplanationStatement {
  return { kind, text, sourceSection, ...(sourceIndex === undefined ? {} : { sourceIndex }) };
}
