import {
  CompilerResultV1,
  ExecutionResultV1,
  FinancialPlanV1,
  GoalContractV1,
  type FinancialPlanStepV1,
  type MoneyV1,
} from "@parlance/contracts";
import { ExplanationInputError } from "./errors.js";
import type {
  DeterministicExplanationV1,
  ExplanationInput,
  ExplanationRenderer,
  ExplanationStatement,
} from "./types.js";

type Goal = GoalContractV1;
type Plan = FinancialPlanV1;

/** Pure, provider-independent rendering from validated deterministic contracts. */
export class DeterministicExplanationRenderer implements ExplanationRenderer {
  explain(input: ExplanationInput): DeterministicExplanationV1 {
    switch (input.subject) {
      case "GOAL":
        return explainGoal(GoalContractV1.parse(input.goal));
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
          return {
            schemaVersion: "1",
            kind: "COMPILER_UNSAT",
            title: "No feasible plan was found",
            statements: [
              statement("REASON", result.reason.message, "compiler.reason"),
              ...result.relaxations.map((relaxation, index) =>
                statement("RELAXATION", `Compiler-provided option: ${relaxation.suggestion}`, "compiler.relaxations", index)
              ),
            ],
          };
        }
        return {
          schemaVersion: "1",
          kind: "POLICY_BLOCKED",
          title: "The request is blocked by policy",
          statements: [statement("REASON", result.reason.message, "compiler.reason")],
        };
      }
      case "EXECUTION_RESULT":
        return explainExecution(ExecutionResultV1.parse(input.result));
    }
  }

  /** Compatibility bridge for the package's pre-existing CompilerExplainer interface. */
  async explainCompilerResult(result: CompilerResultV1): Promise<string> {
    return renderExplanationText(this.explain({ subject: "COMPILER_RESULT", result }));
  }
}

export function renderExplanationText(explanation: DeterministicExplanationV1): string {
  return [explanation.title, ...explanation.statements.map(({ text }) => text)].join("\n");
}

function explainGoal(goal: Goal): DeterministicExplanationV1 {
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

function goalText(goal: Goal, labels: ReadonlyMap<string, string>): string {
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

function constraintText(constraint: Goal["constraints"][number], labels: ReadonlyMap<string, string>): string {
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

function preferenceText(preference: Goal["preferences"][number], labels: ReadonlyMap<string, string>): string {
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

function entityLabels(goal: Goal): ReadonlyMap<string, string> {
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

function statement(
  kind: ExplanationStatement["kind"],
  text: string,
  sourceSection: ExplanationStatement["sourceSection"],
  sourceIndex?: number,
): ExplanationStatement {
  return { kind, text, sourceSection, ...(sourceIndex === undefined ? {} : { sourceIndex }) };
}
