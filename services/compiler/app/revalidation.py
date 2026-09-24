"""Classify changed bank state without executing or approving a replacement plan."""

from dataclasses import dataclass
from typing import Literal

from app.constraints.cost import account_costs, account_costs_for_limit
from app.models.contracts import BankStateSnapshotV1, FinancialPlanV1, GoalContractV1, HardRule
from app.operations.models import FxConvert
from app.planner.compiler import compile_goal
from app.policy.engine import PolicyEngine
from app.preflight import (
    ExecutionProgress,
    PreflightResult,
    SafetyReason,
    _operation,
    preflight_plan,
    reason,
)


@dataclass(frozen=True)
class PlanDifference:
    field: str
    before: str
    after: str

    @property
    def code(self) -> str:
        if self.field == "fxCount":
            if int(self.before) < int(self.after):
                return "FX_ADDED"
            return "FX_REMOVED"
        return {
            "sourceAccount": "SOURCE_ACCOUNT_CHANGED",
            "destinationAccounts": "DESTINATION_ACCOUNT_CHANGED",
            "quoteIds": "FX_QUOTE_CHANGED",
            "operationTypes": "OPERATION_SEQUENCE_CHANGED",
            "irreversibleCount": "IRREVERSIBLE_STEP_COUNT_CHANGED",
            "fees": "FEE_CHANGED",
            "totalCost": "TOTAL_COST_CHANGED",
            "stepCount": "STEP_COUNT_CHANGED",
            "beneficiary": "BENEFICIARY_CHANGED",
            "amount": "AMOUNT_CHANGED",
        }.get(self.field, "PLAN_FACT_CHANGED")


@dataclass(frozen=True)
class RevalidationResult:
    status: Literal[
        "PLAN_STILL_VALID",
        "REPLAN_REQUIRED",
        "GOAL_NOW_UNSAT",
        "POLICY_BLOCKED",
        "REAPPROVAL_REQUIRED_HINT",
        "INVALID_PROGRESS",
        "CANNOT_PROVE_SAFE",
    ]
    reason: SafetyReason | None
    state_version_changed: bool
    differences: tuple[PlanDifference, ...] = ()
    candidate_plan: FinancialPlanV1 | None = None
    preflight_steps_simulated: int = 0
    compiler_calls: int = 0
    replans_available: int = 0


def _facts(plan: FinancialPlanV1) -> dict[str, str]:
    operations = tuple(_operation(step) for step in plan.steps)
    final = operations[-1]
    return {
        "sourceAccount": getattr(operations[0], "source_account_id", ""),
        "destinationAccounts": ",".join(
            getattr(operation, "destination_account_id", "")
            for operation in operations
            if hasattr(operation, "destination_account_id")
        ),
        "fxCount": str(sum(isinstance(item, FxConvert) for item in operations)),
        "stepCount": str(len(plan.steps)),
        "quoteIds": ",".join(sorted(plan.validity.required_quote_ids)),
        "irreversibleCount": str(sum(not step.reversible for step in plan.steps)),
        "operationTypes": ",".join(step.action for step in plan.steps),
        "beneficiary": getattr(final, "beneficiary_id", ""),
        "amount": (
            f"{final.amount.currency}:{final.amount.minor_units}"
            if hasattr(final, "amount")
            else ""
        ),
    }


def plan_differences(
    old: FinancialPlanV1,
    new: FinancialPlanV1,
    snapshot: BankStateSnapshotV1,
    goal: GoalContractV1,
) -> tuple[PlanDifference, ...]:
    before, after = _facts(old), _facts(new)
    result = [
        PlanDifference(key, before[key], after[key])
        for key in sorted(before)
        if before[key] != after[key]
    ]

    def fees(plan: FinancialPlanV1) -> str:
        accounting = account_costs(snapshot, tuple(_operation(step) for step in plan.steps))
        if accounting.missing_quote_ids or accounting.invalid_operations:
            return "UNAVAILABLE"
        return ",".join(
            sorted(
                f"{item.currency}:{item.minor_units}"
                for item in accounting.entries
                if item.component == "FEE" and item.minor_units
            )
        )

    old_fees, new_fees = fees(old), fees(new)
    if old_fees != new_fees:
        result.append(PlanDifference("fees", old_fees, new_fees))
    if hasattr(goal.goal, "amount") and goal.goal.amount is not None:
        currency = goal.goal.amount.currency
        old_cost = account_costs_for_limit(
            snapshot, tuple(_operation(step) for step in old.steps), currency
        )
        new_cost = account_costs_for_limit(
            snapshot, tuple(_operation(step) for step in new.steps), currency
        )
        if all(
            not cost.missing_quote_ids
            and not cost.invalid_operations
            and not cost.foreign_currencies(currency)
            for cost in (old_cost, new_cost)
        ):
            if old_cost.total(currency) != new_cost.total(currency):
                result.append(
                    PlanDifference(
                        "totalCost", str(old_cost.total(currency)), str(new_cost.total(currency))
                    )
                )
    return tuple(result)


def revalidate_plan(
    goal: GoalContractV1,
    plan: FinancialPlanV1,
    snapshot: BankStateSnapshotV1,
    hard_rules: tuple[HardRule, ...] = (),
    policy: PolicyEngine | None = None,
    progress: ExecutionProgress | None = None,
    max_depth: int = 4,
    max_states: int = 1000,
) -> RevalidationResult:
    progress = progress or ExecutionProgress()
    changed = plan.bank_state_version != snapshot.state_version
    preflight: PreflightResult = preflight_plan(goal, plan, snapshot, hard_rules, policy, progress)
    if preflight.status == "READY":
        return RevalidationResult(
            "PLAN_STILL_VALID", None, changed, preflight_steps_simulated=preflight.steps_simulated
        )
    if preflight.status == "INVALID_PROGRESS":
        return RevalidationResult(
            "INVALID_PROGRESS",
            preflight.reason,
            changed,
            preflight_steps_simulated=preflight.steps_simulated,
        )
    if preflight.reason and preflight.reason.code in {
        "GOAL_BINDING_MISMATCH",
        "PLAN_HASH_MISMATCH",
        "STATE_USER_MISMATCH",
        "UNSUPPORTED_GOAL",
        "PRIOR_RESULT_UNKNOWN",
    }:
        return RevalidationResult(
            "CANNOT_PROVE_SAFE",
            preflight.reason,
            changed,
            preflight_steps_simulated=preflight.steps_simulated,
        )
    if progress.completed_step_ids:
        # The original goal may have been partially completed. A new full-goal
        # search cannot prove remaining progress without an execution outcome model.
        return RevalidationResult(
            "CANNOT_PROVE_SAFE",
            reason("PARTIAL_REPLAN_UNPROVEN"),
            changed,
            preflight_steps_simulated=preflight.steps_simulated,
        )
    replanned = compile_goal(goal, snapshot, hard_rules, policy, max_depth, max_states)
    if replanned.status == "POLICY_BLOCKED":
        return RevalidationResult(
            "POLICY_BLOCKED",
            reason(replanned.reason.code),
            changed,
            preflight_steps_simulated=preflight.steps_simulated,
            compiler_calls=1,
        )
    if replanned.status == "UNSAT":
        if replanned.reason.code in {
            "AMBIGUOUS_VALID_PLANS",
            "COST_COMPARISON_UNAVAILABLE",
            "MAX_STATES_EXPLORED",
            "SEARCH_DEPTH_EXHAUSTED",
        }:
            return RevalidationResult(
                "CANNOT_PROVE_SAFE",
                reason(replanned.reason.code),
                changed,
                preflight_steps_simulated=preflight.steps_simulated,
                compiler_calls=1,
            )
        return RevalidationResult(
            "GOAL_NOW_UNSAT",
            reason(replanned.reason.code),
            changed,
            preflight_steps_simulated=preflight.steps_simulated,
            compiler_calls=1,
        )
    differences = plan_differences(plan, replanned.plan, snapshot, goal)
    if any(item.field in {"beneficiary", "amount"} for item in differences):
        status = "REAPPROVAL_REQUIRED_HINT"
    else:
        status = "REPLAN_REQUIRED"
    return RevalidationResult(
        status,
        preflight.reason,
        changed,
        differences,
        replanned.plan,
        preflight.steps_simulated,
        1,
        1,
    )
