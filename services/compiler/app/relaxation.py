"""Exact C5 numeric feasibility using cloned goals and the real C3 compiler."""

from dataclasses import dataclass
from typing import Literal

from app.models.contracts import BankStateSnapshotV1, GoalContractV1, HardRule, MoneyV1
from app.planner.compiler import compile_goal
from app.policy.engine import PolicyEngine
from app.preflight import SafetyReason, reason


@dataclass(frozen=True)
class FeasibilityDiagnostics:
    compiler_calls: int
    relaxation_iterations: int
    lower_bound: int
    upper_bound: int
    final_value: int | None


@dataclass(frozen=True)
class RelaxationFact:
    constraint_type: Literal["MAX_TOTAL_COST", "MIN_AVAILABLE_BALANCE"]
    constraint_index: int
    current_value: MoneyV1
    hypothetical_value: MoneyV1
    value_role: Literal["minimumRequiredValue", "maximumFeasibleValue"]


@dataclass(frozen=True)
class RelaxationResult:
    status: Literal[
        "RELAXATION_FOUND", "NO_REQUEST_RELAXATION", "POLICY_BLOCKED", "CANNOT_PROVE_SAFE"
    ]
    facts: tuple[RelaxationFact, ...]
    reason: SafetyReason | None
    diagnostics: FeasibilityDiagnostics


@dataclass(frozen=True)
class MaximumAmountResult:
    status: Literal["FEASIBLE", "ZERO_FEASIBLE", "POLICY_BLOCKED", "CANNOT_PROVE_SAFE"]
    maximum_feasible_amount: MoneyV1 | None
    reason: SafetyReason | None
    diagnostics: FeasibilityDiagnostics


_UNKNOWN = {
    "MAX_STATES_EXPLORED",
    "SEARCH_DEPTH_EXHAUSTED",
    "AMBIGUOUS_VALID_PLANS",
    "COST_COMPARISON_UNAVAILABLE",
}


def _classify(result) -> Literal["YES", "NO", "POLICY", "UNKNOWN"]:
    if result.status == "SAT":
        return "YES"
    if result.status == "POLICY_BLOCKED":
        return "POLICY"
    if result.reason.code in _UNKNOWN:
        return "UNKNOWN"
    return "NO"


def analyze_request_relaxations(
    goal: GoalContractV1,
    snapshot: BankStateSnapshotV1,
    hard_rules: tuple[HardRule, ...] = (),
    policy: PolicyEngine | None = None,
    max_depth: int = 4,
    max_states: int = 1000,
    max_compiler_calls: int = 128,
) -> RelaxationResult:
    """Find isolated numeric threshold changes; never alter persistent rules."""
    calls = iterations = 0
    seen: dict[tuple[int, int], str] = {}

    def evaluate(index: int, value: int) -> str:
        nonlocal calls
        key = (index, value)
        if key not in seen:
            if calls >= max_compiler_calls:
                return "UNKNOWN"
            hypothetical = goal.model_copy(deep=True)
            hypothetical.constraints[index].money.minor_units = str(value)
            seen[key] = _classify(
                compile_goal(hypothetical, snapshot, hard_rules, policy, max_depth, max_states)
            )
            calls += 1
        return seen[key]

    baseline = compile_goal(goal, snapshot, hard_rules, policy, max_depth, max_states)
    calls += 1
    state = _classify(baseline)
    zero = FeasibilityDiagnostics(calls, 0, 0, 0, None)
    if state == "POLICY":
        return RelaxationResult("POLICY_BLOCKED", (), reason(baseline.reason.code), zero)
    if state == "UNKNOWN":
        return RelaxationResult("CANNOT_PROVE_SAFE", (), reason(baseline.reason.code), zero)
    if state == "YES":
        return RelaxationResult("NO_REQUEST_RELAXATION", (), None, zero)

    facts: list[RelaxationFact] = []
    last_bounds = (0, 0)
    for index, item in enumerate(goal.constraints):
        if item.type not in {"MAX_TOTAL_COST", "MIN_AVAILABLE_BALANCE"}:
            continue
        current = int(item.money.minor_units)
        if current < 0:
            continue
        if item.type == "MAX_TOTAL_COST":
            low, high = current, max(current + 1, 1)
            while evaluate(index, high) == "NO" and high < 10**18:
                iterations += 1
                high *= 2
            last_bounds = (low, high)
            top = evaluate(index, high)
            if top in {"UNKNOWN", "POLICY"}:
                return RelaxationResult(
                    "CANNOT_PROVE_SAFE",
                    (),
                    reason("BOUND_UNPROVEN"),
                    FeasibilityDiagnostics(calls, iterations, low, high, None),
                )
            if top != "YES":
                return RelaxationResult(
                    "CANNOT_PROVE_SAFE",
                    (),
                    reason("UPPER_BOUND_NOT_FEASIBLE"),
                    FeasibilityDiagnostics(calls, iterations, low, high, None),
                )
            while low + 1 < high:
                middle = (low + high) // 2
                probe = evaluate(index, middle)
                iterations += 1
                if probe == "UNKNOWN" or probe == "POLICY":
                    return RelaxationResult(
                        "CANNOT_PROVE_SAFE",
                        (),
                        reason("BOUND_UNPROVEN"),
                        FeasibilityDiagnostics(calls, iterations, low, high, None),
                    )
                if probe == "YES":
                    high = middle
                else:
                    low = middle
            value, role = high, "minimumRequiredValue"
        else:
            low, high = 0, current
            last_bounds = (low, high)
            floor = evaluate(index, low)
            if floor in {"UNKNOWN", "POLICY"}:
                return RelaxationResult(
                    "CANNOT_PROVE_SAFE",
                    (),
                    reason("BOUND_UNPROVEN"),
                    FeasibilityDiagnostics(calls, iterations, low, high, None),
                )
            if floor != "YES":
                continue
            while low + 1 < high:
                middle = (low + high) // 2
                probe = evaluate(index, middle)
                iterations += 1
                if probe in {"UNKNOWN", "POLICY"}:
                    return RelaxationResult(
                        "CANNOT_PROVE_SAFE",
                        (),
                        reason("BOUND_UNPROVEN"),
                        FeasibilityDiagnostics(calls, iterations, low, high, None),
                    )
                if probe == "YES":
                    low = middle
                else:
                    high = middle
            value, role = low, "maximumFeasibleValue"
        facts.append(
            RelaxationFact(
                item.type,
                index,
                item.money.model_copy(deep=True),
                MoneyV1(currency=item.money.currency, minorUnits=str(value)),
                role,
            )
        )
    final = facts[0].hypothetical_value.minor_units if facts else None
    diagnostics = FeasibilityDiagnostics(
        calls, iterations, *last_bounds, int(final) if final is not None else None
    )
    return RelaxationResult(
        "RELAXATION_FOUND" if facts else "NO_REQUEST_RELAXATION", tuple(facts), None, diagnostics
    )


def find_max_feasible_amount(
    goal_template: GoalContractV1,
    snapshot: BankStateSnapshotV1,
    upper_bound: int,
    hard_rules: tuple[HardRule, ...] = (),
    policy: PolicyEngine | None = None,
    max_depth: int = 4,
    max_states: int = 1000,
    max_compiler_calls: int = 128,
) -> MaximumAmountResult:
    """Largest compiler-SAT positive amount within a caller-supplied exact bound."""
    if upper_bound < 0:
        raise ValueError("upper_bound must be nonnegative")
    if goal_template.goal.type not in {"DELIVER_MONEY", "MOVE_FUNDS"}:
        return MaximumAmountResult(
            "CANNOT_PROVE_SAFE",
            None,
            reason("UNSUPPORTED_GOAL"),
            FeasibilityDiagnostics(0, 0, 0, upper_bound, None),
        )
    if upper_bound == 0:
        return MaximumAmountResult(
            "ZERO_FEASIBLE", None, None, FeasibilityDiagnostics(0, 0, 0, 0, 0)
        )
    calls = iterations = 0

    def evaluate(value: int) -> str:
        nonlocal calls
        if calls >= max_compiler_calls:
            return "UNKNOWN"
        hypothetical = goal_template.model_copy(deep=True)
        hypothetical.goal.amount.minor_units = str(value)
        calls += 1
        return _classify(
            compile_goal(hypothetical, snapshot, hard_rules, policy, max_depth, max_states)
        )

    first = evaluate(1)
    if first == "POLICY":
        return MaximumAmountResult(
            "POLICY_BLOCKED",
            None,
            reason("BANK_POLICY_BLOCKED"),
            FeasibilityDiagnostics(calls, 0, 0, upper_bound, None),
        )
    if first == "UNKNOWN":
        return MaximumAmountResult(
            "CANNOT_PROVE_SAFE",
            None,
            reason("BOUND_UNPROVEN"),
            FeasibilityDiagnostics(calls, 0, 0, upper_bound, None),
        )
    if first == "NO":
        return MaximumAmountResult(
            "ZERO_FEASIBLE", None, None, FeasibilityDiagnostics(calls, 0, 0, upper_bound, 0)
        )
    low, high = 1, upper_bound + 1
    while low + 1 < high:
        middle = (low + high) // 2
        probe = evaluate(middle)
        iterations += 1
        if probe in {"UNKNOWN", "POLICY"}:
            return MaximumAmountResult(
                "CANNOT_PROVE_SAFE",
                None,
                reason("BOUND_UNPROVEN"),
                FeasibilityDiagnostics(calls, iterations, low, high, None),
            )
        if probe == "YES":
            low = middle
        else:
            high = middle
    # Explicitly prove the returned amount with the compiler.
    if evaluate(low) != "YES":
        return MaximumAmountResult(
            "CANNOT_PROVE_SAFE",
            None,
            reason("FINAL_VALUE_UNPROVEN"),
            FeasibilityDiagnostics(calls, iterations, low, high, None),
        )
    amount = MoneyV1(currency=goal_template.goal.amount.currency, minorUnits=str(low))
    return MaximumAmountResult(
        "FEASIBLE", amount, None, FeasibilityDiagnostics(calls, iterations, low, upper_bound, low)
    )
