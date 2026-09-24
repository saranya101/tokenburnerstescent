"""Fair local-step validator: same C1/C2 facts, no future-goal preservation."""

from dataclasses import dataclass

from app.constraints.evaluator import evaluate_constraints
from app.models.contracts import (
    BankStateSnapshotV1,
    FinancialPlanV1,
    GoalContractV1,
    HardRule,
)
from app.policy.engine import PolicyEngine
from app.preflight import _operation
from app.simulator.apply import apply_operation


@dataclass(frozen=True)
class BaselineResult:
    locally_valid_steps_allowed: int
    final_goal_succeeded: bool
    whole_goal_failure: bool
    stranded_intermediate_steps: int
    policy_violations_allowed: int
    constraint_violations_allowed: int
    stopped_reason: str | None


def validate_proposed_sequence(
    goal: GoalContractV1,
    plan: FinancialPlanV1,
    state: BankStateSnapshotV1,
    rules: tuple[HardRule, ...] = (),
    policy: PolicyEngine | None = None,
) -> BaselineResult:
    """Validate proposed steps locally, including policy and cumulative constraints.

    This model has the same state, quote data, arithmetic, and policy as Parlance.
    It does not synthesize an alternative route or ask whether a valid first step
    preserves the final approved goal.
    """
    policy = policy or PolicyEngine()
    current = state
    performed = []
    stopped_reason = None
    for step in plan.steps:
        operation = _operation(step)
        if operation is None:
            stopped_reason = "UNSUPPORTED_STEP"
            break
        decision = policy.evaluate(current, operation)
        if not decision.allowed:
            stopped_reason = decision.violations[0].code
            break
        transition = apply_operation(current, operation)
        if not transition.success:
            stopped_reason = transition.violations[0].code
            break
        projected = transition.state.to_snapshot()
        check = evaluate_constraints(
            goal, state, projected, (*performed, operation), rules
        )
        if not check.valid:
            stopped_reason = check.violations[0].code
            break
        performed.append(operation)
        current = projected
    succeeded = len(performed) == len(plan.steps)
    return BaselineResult(
        locally_valid_steps_allowed=len(performed),
        final_goal_succeeded=succeeded,
        whole_goal_failure=not succeeded,
        stranded_intermediate_steps=len(performed) if not succeeded else 0,
        policy_violations_allowed=0,
        constraint_violations_allowed=0,
        stopped_reason=stopped_reason,
    )
