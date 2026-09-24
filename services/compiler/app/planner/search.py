"""Bounded state search over C1 transitions and C2 decisions."""

from collections import deque
from dataclasses import dataclass

from app.constraints.evaluator import evaluate_constraints
from app.constraints.models import ConstraintViolation
from app.models.contracts import BankStateSnapshotV1, GoalContractV1, HardRule
from app.operations.library import operation_sort_key
from app.operations.models import InternalOperation, MoveFunds, Transfer
from app.planner.candidates import enumerate_candidates
from app.policy.engine import PolicyEngine, PolicyViolation
from app.simulator.apply import OperationViolation, apply_operation
from app.simulator.state import SimulatedState


@dataclass(frozen=True)
class SearchNode:
    state: SimulatedState
    operations: tuple[InternalOperation, ...]
    # Beneficiary/goal completion is a planner event; V1 has no beneficiary balance.
    completion: tuple[str, str, int] | None = None
    history: tuple[str, ...] = ()


@dataclass(frozen=True)
class SearchDiagnostics:
    states_explored: int
    candidate_actions_evaluated: int
    solver_calls: int
    search_depth_reached: int
    operation_violations: tuple[OperationViolation, ...]
    constraint_violations: tuple[ConstraintViolation, ...]
    policy_violations: tuple[PolicyViolation, ...]
    depth_limited: bool = False
    states_limited: bool = False
    pruned_by_policy: int = 0
    pruned_by_constraint: int = 0
    pruned_visited_states: int = 0
    valid_plans_found: int = 0


@dataclass(frozen=True)
class SearchResult:
    solutions: tuple[SearchNode, ...]
    diagnostics: SearchDiagnostics


def _completion(goal: GoalContractV1, operation: InternalOperation) -> tuple[str, str, int] | None:
    target = goal.goal
    if target.type == "DELIVER_MONEY" and isinstance(operation, Transfer):
        if (
            operation.beneficiary_id == target.recipient_id
            and operation.amount.currency == target.amount.currency
            and operation.amount.minor_units == int(target.amount.minor_units)
        ):
            return ("DELIVER_MONEY", target.recipient_id, operation.amount.minor_units)
    if target.type == "MOVE_FUNDS" and isinstance(operation, MoveFunds):
        if (
            operation.destination_account_id == target.destination_account_id
            and operation.amount.currency == target.amount.currency
            and operation.amount.minor_units == int(target.amount.minor_units)
            and (
                target.source_account_id is None
                or operation.source_account_id == target.source_account_id
            )
        ):
            return ("MOVE_FUNDS", target.destination_account_id, operation.amount.minor_units)
    return None


def _prunable(violations: tuple[ConstraintViolation, ...], completed: bool) -> bool:
    if completed:
        return bool(violations)
    # A later credit can restore a minimum; foreign FX funding attribution may
    # become knowable after downstream use. These checks remain final gates.
    return any(
        item.code
        in {
            "EXCLUDED_ACCOUNT_USED",
            "MAX_TOTAL_COST_VIOLATED",
            "MAX_SINGLE_TRANSACTION_VIOLATED",
            "HARD_RULE_USER_MISMATCH",
            "STATE_USER_MISMATCH",
        }
        for item in violations
    )


def search_routes(
    goal: GoalContractV1,
    snapshot: BankStateSnapshotV1,
    hard_rules: tuple[HardRule, ...],
    policy: PolicyEngine,
    max_depth: int = 4,
    max_states: int = 1000,
) -> SearchResult:
    if max_depth < 1:
        raise ValueError("max_depth must be positive")
    if max_states < 1:
        raise ValueError("max_states must be positive")
    initial = SimulatedState.from_snapshot(snapshot)
    root = SearchNode(initial, (), history=(initial.digest(),))
    frontier = deque([root])
    visited: set[tuple[str, tuple]] = {(root.state.digest(), ())}
    solutions: list[SearchNode] = []
    operation_errors: list[OperationViolation] = []
    constraint_errors: list[ConstraintViolation] = []
    policy_errors: list[PolicyViolation] = []
    explored = evaluated = depth_reached = 0
    depth_limited = False
    states_limited = False
    pruned_policy = pruned_constraint = pruned_visited = 0
    while frontier:
        if explored >= max_states:
            states_limited = True
            break
        node = frontier.popleft()
        explored += 1
        depth_reached = max(depth_reached, len(node.operations))
        if len(node.operations) >= max_depth:
            depth_limited = True
            continue
        for operation in enumerate_candidates(goal, node.state.to_snapshot()):
            evaluated += 1
            decision = policy.evaluate(node.state, operation)
            if not decision.allowed:
                policy_errors.extend(decision.violations)
                pruned_policy += 1
                continue
            transition = apply_operation(node.state, operation)
            if not transition.success:
                operation_errors.extend(transition.violations)
                continue
            route = (*node.operations, operation)
            completion = _completion(goal, operation)
            evaluation = evaluate_constraints(goal, snapshot, transition.state, route, hard_rules)
            if _prunable(evaluation.violations, completion is not None):
                constraint_errors.extend(evaluation.violations)
                pruned_constraint += 1
                continue
            digest = transition.state.digest()
            if digest in node.history:
                pruned_visited += 1
                continue
            next_node = SearchNode(transition.state, route, completion, (*node.history, digest))
            if completion is not None:
                if evaluation.valid:
                    solutions.append(next_node)
                else:
                    constraint_errors.extend(evaluation.violations)
                    pruned_constraint += 1
                continue
            # Balance alone cannot capture quote, fee, and funding provenance.
            # The local state history prevents A→B→A loops; this key deduplicates
            # identical financial state and route metadata across the frontier.
            identity = (digest, tuple(operation_sort_key(item) for item in route))
            if identity in visited:
                pruned_visited += 1
                continue
            visited.add(identity)
            frontier.append(next_node)
    return SearchResult(
        tuple(solutions),
        SearchDiagnostics(
            explored,
            evaluated,
            0,
            depth_reached,
            tuple(operation_errors),
            tuple(constraint_errors),
            tuple(policy_errors),
            depth_limited,
            states_limited,
            pruned_policy,
            pruned_constraint,
            pruned_visited,
            len(solutions),
        ),
    )
