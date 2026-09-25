"""Pure C4 safety checks for an already compiled money-movement plan."""

import hashlib
import json
from dataclasses import dataclass
from typing import Literal

from app.constraints.evaluator import evaluate_constraints
from app.models.contracts import (
    BankStateSnapshotV1,
    DeliverMoneyGroundedGoalV1,
    FinancialPlanV1,
    GoalContractV1,
    HardRule,
    MoveFundsGroundedGoalV1,
)
from app.operations.library import OPERATION_LIBRARY, operation_sort_key
from app.operations.models import FxConvert, InternalOperation, Money, MoveFunds, Transfer
from app.planner.compiler import compile_goal, plan_id_for_inputs
from app.policy.engine import PolicyEngine
from app.simulator.apply import apply_operation
from app.simulator.state import SimulatedState


@dataclass(frozen=True)
class ExecutionProgress:
    """IDs of steps whose successful settlement is known, in plan order."""

    completed_step_ids: tuple[str, ...] = ()
    unknown_step_ids: tuple[str, ...] = ()


@dataclass(frozen=True)
class SafetyReason:
    code: str
    details: tuple[tuple[str, str], ...] = ()


def reason(code: str, **details: object) -> SafetyReason:
    return SafetyReason(code, tuple(sorted((key, str(value)) for key, value in details.items())))


@dataclass(frozen=True)
class PreflightResult:
    status: Literal[
        "READY",
        "INVALID_PLAN",
        "STATE_CHANGED",
        "POLICY_BLOCKED",
        "GOAL_NO_LONGER_SATISFIABLE",
        "INVALID_PROGRESS",
        "CANNOT_PROVE_SAFE",
    ]
    reason: SafetyReason | None
    steps_simulated: int
    resulting_state: SimulatedState | None = None


@dataclass(frozen=True)
class GoalPreservationResult:
    status: Literal[
        "PRESERVED",
        "WOULD_BREAK_GOAL",
        "REPLAN_REQUIRED",
        "POLICY_BLOCKED",
        "STALE_PLAN",
        "INVALID_NEXT_STEP",
        "INVALID_PROGRESS",
        "CANNOT_PROVE_SAFE",
    ]
    reason: SafetyReason | None
    compiler_calls: int
    resulting_state: SimulatedState | None = None


def _plan_hash_valid(plan: FinancialPlanV1) -> bool:
    payload = plan.model_dump(mode="json", by_alias=True, exclude_none=True)
    supplied = payload.pop("planHash")
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(canonical.encode()).hexdigest() == supplied


def _operation(step) -> InternalOperation | None:
    parameters = step.parameters
    if step.action == "TRANSFER":
        return Transfer(
            parameters.source_account_id,
            parameters.beneficiary_id,
            Money(parameters.amount.currency, int(parameters.amount.minor_units)),
        )
    if step.action == "MOVE_FUNDS":
        return MoveFunds(
            parameters.source_account_id,
            parameters.destination_account_id,
            Money(parameters.amount.currency, int(parameters.amount.minor_units)),
        )
    if step.action == "FX_CONVERT":
        return FxConvert(
            parameters.source_account_id,
            parameters.destination_account_id,
            Money(parameters.source_money.currency, int(parameters.source_money.minor_units)),
            parameters.target_currency,
            parameters.quote_id,
        )
    return None


def _completion(goal: GoalContractV1, operation: InternalOperation) -> bool:
    target = goal.goal
    if isinstance(target, DeliverMoneyGroundedGoalV1) and isinstance(operation, Transfer):
        return (
            operation.beneficiary_id == target.recipient_id
            and operation.amount.currency == target.amount.currency
            and operation.amount.minor_units == int(target.amount.minor_units)
        )
    if isinstance(target, MoveFundsGroundedGoalV1) and isinstance(operation, MoveFunds):
        return (
            operation.destination_account_id == target.destination_account_id
            and (
                target.source_account_id is None
                or operation.source_account_id == target.source_account_id
            )
            and operation.amount.currency == target.amount.currency
            and operation.amount.minor_units == int(target.amount.minor_units)
        )
    return False


def _validate_structure(goal: GoalContractV1, plan: FinancialPlanV1) -> SafetyReason | None:
    if goal.status != "CONFIRMED":
        return reason("GOAL_NOT_CONFIRMED")
    if plan.goal_contract_id != goal.id or plan.goal_contract_version != goal.version:
        return reason("GOAL_BINDING_MISMATCH")
    if not _plan_hash_valid(plan):
        return reason("PLAN_HASH_MISMATCH")
    if not isinstance(goal.goal, (DeliverMoneyGroundedGoalV1, MoveFundsGroundedGoalV1)):
        return reason("UNSUPPORTED_GOAL")
    if not plan.steps:
        return reason("EMPTY_PLAN")
    seen: set[str] = set()
    for index, step in enumerate(plan.steps):
        if step.id in seen or step.sequence != index:
            return reason("STEP_ORDER_INVALID", index=index)
        if step.depends_on != ([plan.steps[index - 1].id] if index else []):
            return reason("DEPENDENCY_INVALID", index=index)
        if step.action not in ("TRANSFER", "MOVE_FUNDS", "FX_CONVERT"):
            return reason("UNSUPPORTED_STEP", index=index, action=step.action)
        if step.reversible != OPERATION_LIBRARY[step.action].reversible:
            return reason("REVERSIBILITY_MISMATCH", index=index)
        seen.add(step.id)
    operations = tuple(_operation(step) for step in plan.steps)
    if any(operation is None for operation in operations):
        return reason("UNSUPPORTED_STEP")
    if not _completion(goal, operations[-1]):
        return reason("GOAL_COMPLETION_MISSING")
    if any(_completion(goal, operation) for operation in operations[:-1]):
        return reason("PREMATURE_GOAL_COMPLETION")
    quotes = [operation.quote_id for operation in operations if isinstance(operation, FxConvert)]
    if len(plan.validity.required_quote_ids) != len(set(plan.validity.required_quote_ids)):
        return reason("DUPLICATE_REQUIRED_QUOTE")
    if set(plan.validity.required_quote_ids) != set(quotes):
        return reason("QUOTE_BINDINGS_MISMATCH")
    if not plan.projected_outcome.goal_satisfied:
        return reason("PROJECTED_GOAL_MISMATCH")
    if isinstance(goal.goal, DeliverMoneyGroundedGoalV1):
        if plan.projected_outcome.delivered_money != goal.goal.amount:
            return reason("PROJECTED_DELIVERY_MISMATCH")
    elif plan.projected_outcome.delivered_money is not None:
        return reason("PROJECTED_DELIVERY_MISMATCH")
    return None


def _validate_progress(plan: FinancialPlanV1, progress: ExecutionProgress) -> SafetyReason | None:
    completed = progress.completed_step_ids
    if progress.unknown_step_ids:
        return reason("PRIOR_RESULT_UNKNOWN", stepIds=progress.unknown_step_ids)
    if len(completed) > len(plan.steps) or completed != tuple(
        step.id for step in plan.steps[: len(completed)]
    ):
        return reason("COMPLETED_STEPS_NOT_PREFIX")
    return None


def _quote_check(
    plan: FinancialPlanV1, snapshot: BankStateSnapshotV1, remaining
) -> SafetyReason | None:
    ids = {step.parameters.quote_id for step in remaining if step.action == "FX_CONVERT"}
    for quote_id in sorted(ids):
        quote = next((item for item in snapshot.fx_quotes if item.id == quote_id), None)
        if quote is None:
            return reason("QUOTE_NOT_FOUND", quoteId=quote_id)
        if quote.expires_at <= snapshot.captured_at:
            return reason("QUOTE_EXPIRED", quoteId=quote_id)
        if plan.validity.valid_until is None or plan.validity.valid_until > quote.expires_at:
            return reason("QUOTE_VALIDITY_MISMATCH", quoteId=quote_id)
    if (
        ids
        and plan.validity.valid_until is not None
        and plan.validity.valid_until <= snapshot.captured_at
    ):
        return reason("PLAN_VALIDITY_EXPIRED")
    return None


def _fx_binding_proven(
    goal: GoalContractV1,
    plan: FinancialPlanV1,
    snapshot: BankStateSnapshotV1,
    hard_rules: tuple[HardRule, ...],
    policy: PolicyEngine,
) -> bool:
    if plan.bank_state_version != snapshot.state_version:
        return False
    operations = tuple(_operation(step) for step in plan.steps)
    return plan.id == plan_id_for_inputs(
        goal, snapshot, hard_rules, policy, operations, plan.compiler_version
    )


def _projected_balances_match(
    plan: FinancialPlanV1, state: SimulatedState, touched: set[str], same_version: bool
) -> bool:
    actual = {
        item.id: (item.currency, item.available_minor_units)
        for item in state.to_snapshot().accounts
    }
    projected = {
        item.account_id: (item.money.currency, item.money.minor_units)
        for item in plan.projected_outcome.projected_available_balances
    }
    if len(projected) != len(plan.projected_outcome.projected_available_balances):
        return False
    accounts = set(actual) if same_version else touched
    return all(actual.get(account) == projected.get(account) for account in accounts)


def preflight_plan(
    goal: GoalContractV1,
    plan: FinancialPlanV1,
    snapshot: BankStateSnapshotV1,
    hard_rules: tuple[HardRule, ...] = (),
    policy: PolicyEngine | None = None,
    progress: ExecutionProgress | None = None,
) -> PreflightResult:
    progress = progress or ExecutionProgress()
    invalid = _validate_structure(goal, plan)
    if invalid:
        return PreflightResult("INVALID_PLAN", invalid, 0)
    invalid = _validate_progress(plan, progress)
    if invalid:
        return PreflightResult("INVALID_PROGRESS", invalid, 0)
    if goal.user_id != snapshot.user_id:
        return PreflightResult("CANNOT_PROVE_SAFE", reason("STATE_USER_MISMATCH"), 0)
    if progress.completed_step_ids and any(
        item.type == "MAX_TOTAL_COST" for item in goal.constraints
    ):
        return PreflightResult("CANNOT_PROVE_SAFE", reason("PRIOR_COST_PROVENANCE_UNAVAILABLE"), 0)
    remaining = plan.steps[len(progress.completed_step_ids) :]
    quote_issue = _quote_check(plan, snapshot, remaining)
    if quote_issue:
        return PreflightResult("INVALID_PLAN", quote_issue, 0)
    state = SimulatedState.from_snapshot(snapshot)
    operations: list[InternalOperation] = []
    touched: set[str] = set()
    policy = policy or PolicyEngine()
    for index, step in enumerate(remaining, start=len(progress.completed_step_ids)):
        operation = _operation(step)
        decision = policy.evaluate(state, operation)
        if not decision.allowed:
            issue = decision.violations[0]
            return PreflightResult(
                "POLICY_BLOCKED", reason(issue.code, stepIndex=index), len(operations)
            )
        transition = apply_operation(state, operation)
        if not transition.success:
            issue = transition.violations[0]
            return PreflightResult(
                "INVALID_PLAN", reason(issue.code, stepIndex=index), len(operations)
            )
        state = transition.state
        operations.append(operation)
        touched.add(operation.source_account_id)
        if isinstance(operation, (FxConvert, MoveFunds)):
            touched.add(operation.destination_account_id)
        evaluation = evaluate_constraints(goal, snapshot, state, tuple(operations), hard_rules)
        if evaluation.violations and index == len(plan.steps) - 1:
            return PreflightResult(
                "GOAL_NO_LONGER_SATISFIABLE", reason(evaluation.violations[0].code), len(operations)
            )
    if not remaining and not progress.completed_step_ids:
        return PreflightResult("INVALID_PLAN", reason("EMPTY_REMAINING_PLAN"), 0)
    if remaining and not _completion(goal, operations[-1]):
        return PreflightResult("INVALID_PLAN", reason("GOAL_COMPLETION_MISSING"), len(operations))
    if not progress.completed_step_ids and not _projected_balances_match(
        plan, state, touched, plan.bank_state_version == snapshot.state_version
    ):
        return PreflightResult(
            "INVALID_PLAN", reason("PROJECTED_BALANCE_MISMATCH"), len(operations)
        )
    if any(step.action == "FX_CONVERT" for step in remaining) and not _fx_binding_proven(
        goal, plan, snapshot, hard_rules, policy
    ):
        return PreflightResult("STATE_CHANGED", reason("FX_BINDING_UNPROVEN"), len(operations))
    return PreflightResult("READY", None, len(operations), state)


def check_step_goal_preservation(
    goal: GoalContractV1,
    plan: FinancialPlanV1,
    next_step_index: int,
    snapshot: BankStateSnapshotV1,
    hard_rules: tuple[HardRule, ...] = (),
    policy: PolicyEngine | None = None,
    progress: ExecutionProgress | None = None,
    max_depth: int = 4,
    max_states: int = 1000,
) -> GoalPreservationResult:
    progress = progress or ExecutionProgress()
    invalid = _validate_structure(goal, plan)
    if invalid:
        return GoalPreservationResult("STALE_PLAN", invalid, 0)
    invalid = _validate_progress(plan, progress)
    if invalid or next_step_index != len(progress.completed_step_ids):
        return GoalPreservationResult(
            "INVALID_PROGRESS", invalid or reason("NEXT_STEP_NOT_EXPECTED"), 0
        )
    if next_step_index >= len(plan.steps):
        return GoalPreservationResult("INVALID_NEXT_STEP", reason("NO_NEXT_STEP"), 0)
    if goal.user_id != snapshot.user_id:
        return GoalPreservationResult("CANNOT_PROVE_SAFE", reason("STATE_USER_MISMATCH"), 0)
    step = plan.steps[next_step_index]
    quote_issue = _quote_check(plan, snapshot, (step,))
    if quote_issue:
        return GoalPreservationResult("STALE_PLAN", quote_issue, 0)
    fx_binding_unproven = step.action == "FX_CONVERT" and not _fx_binding_proven(
        goal, plan, snapshot, hard_rules, policy or PolicyEngine()
    )
    operation = _operation(step)
    state = SimulatedState.from_snapshot(snapshot)
    decision = (policy or PolicyEngine()).evaluate(state, operation)
    if not decision.allowed:
        return GoalPreservationResult("POLICY_BLOCKED", reason(decision.violations[0].code), 0)
    transition = apply_operation(state, operation)
    if not transition.success:
        return GoalPreservationResult("INVALID_NEXT_STEP", reason(transition.violations[0].code), 0)
    evaluation = evaluate_constraints(goal, snapshot, transition.state, (operation,), hard_rules)
    if any(
        item.code
        in {"EXCLUDED_ACCOUNT_USED", "MAX_TOTAL_COST_VIOLATED", "MAX_SINGLE_TRANSACTION_VIOLATED"}
        for item in evaluation.violations
    ):
        return GoalPreservationResult("WOULD_BREAK_GOAL", reason(evaluation.violations[0].code), 0)
    if _completion(goal, operation):
        if not evaluation.valid:
            return GoalPreservationResult(
                "WOULD_BREAK_GOAL", reason(evaluation.violations[0].code), 0
            )
        if fx_binding_unproven:
            return GoalPreservationResult("STALE_PLAN", reason("FX_BINDING_UNPROVEN"), 0)
        return GoalPreservationResult("PRESERVED", None, 0, transition.state)
    if any(item.type == "MAX_TOTAL_COST" for item in goal.constraints):
        return GoalPreservationResult(
            "CANNOT_PROVE_SAFE", reason("COST_PROVENANCE_AFTER_STEP_UNAVAILABLE"), 0
        )
    # Current supported goals have atomic final completion. Precursor moves/FX
    # leave the full grounded goal outstanding; this is explicit progress, not
    # an assumption that a partial beneficiary payment already occurred.
    hypothetical = transition.state.to_snapshot()
    remaining = compile_goal(goal, hypothetical, hard_rules, policy, max_depth, max_states)
    if remaining.status != "SAT":
        return GoalPreservationResult(
            "WOULD_BREAK_GOAL", reason(remaining.reason.code, compilerStatus=remaining.status), 1
        )
    if fx_binding_unproven:
        return GoalPreservationResult("STALE_PLAN", reason("FX_BINDING_UNPROVEN"), 1)
    approved_remainder = tuple(
        operation_sort_key(_operation(item)) for item in plan.steps[next_step_index + 1 :]
    )
    discovered_remainder = tuple(
        operation_sort_key(_operation(item)) for item in remaining.plan.steps
    )
    if approved_remainder != discovered_remainder:
        return GoalPreservationResult("REPLAN_REQUIRED", reason("REMAINING_ROUTE_CHANGED"), 1)
    return GoalPreservationResult("PRESERVED", None, 1, transition.state)
