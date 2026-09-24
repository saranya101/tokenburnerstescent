"""C5 deterministic replanning and structured feasibility evidence."""

from dataclasses import dataclass
from typing import Literal

from app.models.contracts import BankStateSnapshotV1, FinancialPlanV1, GoalContractV1, HardRule
from app.planner.compiler import compile_with_diagnostics
from app.policy.engine import PolicyEngine
from app.preflight import ExecutionProgress, SafetyReason, reason
from app.revalidation import PlanDifference, plan_differences, revalidate_plan


@dataclass(frozen=True)
class UnsatExplanation:
    primary: SafetyReason
    secondary_codes: tuple[str, ...]
    classification: Literal["UNSAT", "POLICY_BLOCKED", "CANNOT_PROVE_SAFE"]


@dataclass(frozen=True)
class ReplanResult:
    status: Literal[
        "PLAN_STILL_VALID", "REPLANNED", "GOAL_UNSAT", "POLICY_BLOCKED", "CANNOT_PROVE_SAFE"
    ]
    reason: SafetyReason | None
    plan: FinancialPlanV1 | None
    differences: tuple[PlanDifference, ...]
    explanation: UnsatExplanation | None
    compiler_calls: int


_PRECEDENCE = (
    "EXCLUDED_ACCOUNT_PREVENTS_ROUTE",
    "MIN_AVAILABLE_BALANCE_VIOLATED",
    "MAX_TOTAL_COST_TOO_LOW",
    "QUOTE_EXPIRED",
    "INSUFFICIENT_FUNDS",
    "NO_ELIGIBLE_SOURCE_ACCOUNT",
    "NO_ELIGIBLE_DESTINATION_ACCOUNT",
    "NO_FX_ROUTE",
    "NO_TRANSFER_ROUTE",
)
_UNCERTAIN = {
    "MAX_STATES_EXPLORED",
    "SEARCH_DEPTH_EXHAUSTED",
    "AMBIGUOUS_VALID_PLANS",
    "COST_COMPARISON_UNAVAILABLE",
}


def explain_unsat(
    goal: GoalContractV1,
    snapshot: BankStateSnapshotV1,
    hard_rules: tuple[HardRule, ...] = (),
    policy: PolicyEngine | None = None,
    max_depth: int = 4,
    max_states: int = 1000,
) -> UnsatExplanation | None:
    outcome = compile_with_diagnostics(goal, snapshot, hard_rules, policy, max_depth, max_states)
    result = outcome.result
    if result.status == "SAT":
        return None
    codes = {result.reason.code}
    diagnostics = outcome.diagnostics
    if diagnostics is not None:
        conversion = {
            "EXCLUDED_ACCOUNT_USED": "EXCLUDED_ACCOUNT_PREVENTS_ROUTE",
            "MAX_TOTAL_COST_VIOLATED": "MAX_TOTAL_COST_TOO_LOW",
        }
        codes.update(
            conversion.get(item.code, item.code) for item in diagnostics.constraint_violations
        )
        codes.update(item.code for item in diagnostics.operation_violations)
        if diagnostics.states_limited or diagnostics.depth_limited:
            codes.add("SEARCH_BOUND_REACHED")
    if result.status == "POLICY_BLOCKED":
        primary = result.reason.code
        classification = "POLICY_BLOCKED"
    elif result.reason.code in _UNCERTAIN:
        primary = (
            "SEARCH_BOUND_REACHED"
            if result.reason.code in {"MAX_STATES_EXPLORED", "SEARCH_DEPTH_EXHAUSTED"}
            else result.reason.code
        )
        classification = "CANNOT_PROVE_SAFE"
    else:
        # The compiler's terminal classification is authoritative. Search
        # violations from rejected alternatives are only secondary evidence.
        primary = result.reason.code
        classification = "UNSAT"
    secondary = tuple(
        sorted(
            codes - {primary},
            key=lambda code: (
                _PRECEDENCE.index(code) if code in _PRECEDENCE else len(_PRECEDENCE),
                code,
            ),
        )
    )
    return UnsatExplanation(reason(primary), secondary, classification)


def _target_preserved(goal: GoalContractV1, plan: FinancialPlanV1) -> bool:
    if plan.goal_contract_id != goal.id or plan.goal_contract_version != goal.version:
        return False
    if goal.goal.type == "DELIVER_MONEY":
        last = plan.steps[-1]
        return (
            last.action == "TRANSFER"
            and last.parameters.beneficiary_id == goal.goal.recipient_id
            and last.parameters.amount == goal.goal.amount
        )
    if goal.goal.type == "MOVE_FUNDS":
        last = plan.steps[-1]
        return (
            last.action == "MOVE_FUNDS"
            and last.parameters.destination_account_id == goal.goal.destination_account_id
            and last.parameters.amount == goal.goal.amount
            and (
                goal.goal.source_account_id is None
                or last.parameters.source_account_id == goal.goal.source_account_id
            )
        )
    return False


def replan_goal(
    goal: GoalContractV1,
    previous_plan: FinancialPlanV1,
    current_state: BankStateSnapshotV1,
    hard_rules: tuple[HardRule, ...] = (),
    policy: PolicyEngine | None = None,
    progress: ExecutionProgress | None = None,
    max_depth: int = 4,
    max_states: int = 1000,
) -> ReplanResult:
    checked = revalidate_plan(
        goal, previous_plan, current_state, hard_rules, policy, progress, max_depth, max_states
    )
    if checked.status == "PLAN_STILL_VALID":
        return ReplanResult("PLAN_STILL_VALID", None, previous_plan, (), None, 0)
    if checked.status == "POLICY_BLOCKED":
        return ReplanResult(
            "POLICY_BLOCKED", checked.reason, None, (), None, checked.compiler_calls
        )
    if checked.status in {"CANNOT_PROVE_SAFE", "INVALID_PROGRESS"}:
        return ReplanResult(
            "CANNOT_PROVE_SAFE", checked.reason, None, (), None, checked.compiler_calls
        )
    if checked.status in {"REPLAN_REQUIRED", "REAPPROVAL_REQUIRED_HINT"}:
        candidate = checked.candidate_plan
        if candidate is None or not _target_preserved(goal, candidate):
            return ReplanResult(
                "CANNOT_PROVE_SAFE",
                reason("TARGET_BINDING_MISMATCH"),
                None,
                (),
                None,
                checked.compiler_calls,
            )
        return ReplanResult(
            "REPLANNED",
            checked.reason,
            candidate,
            plan_differences(previous_plan, candidate, current_state, goal),
            None,
            checked.compiler_calls,
        )
    explanation = explain_unsat(goal, current_state, hard_rules, policy, max_depth, max_states)
    if explanation is None:
        return ReplanResult(
            "CANNOT_PROVE_SAFE",
            reason("INCONSISTENT_FEASIBILITY"),
            None,
            (),
            None,
            checked.compiler_calls + 1,
        )
    status = "GOAL_UNSAT" if explanation.classification == "UNSAT" else explanation.classification
    return ReplanResult(
        status, explanation.primary, None, (), explanation, checked.compiler_calls + 1
    )
