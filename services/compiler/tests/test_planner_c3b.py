"""C3B route materiality, bounds, and executable-plan invariants."""

import hashlib
import json
from copy import deepcopy

from test_planner_c3a import account, constraint, fixture, hard, preference

from app.constraints.evaluator import evaluate_constraints
from app.operations.models import FxConvert, Money, MoveFunds, Transfer
from app.planner.candidates import enumerate_candidates
from app.planner.compiler import compile_goal, compile_with_diagnostics, plans_materially_equivalent
from app.planner.search import SearchNode
from app.policy.engine import PolicyEngine
from app.simulator.apply import apply_operation
from app.simulator.state import SimulatedState


def _operation(step):
    params = step.parameters
    if step.action == "TRANSFER":
        return Transfer(
            params.source_account_id,
            params.beneficiary_id,
            Money(params.amount.currency, int(params.amount.minor_units)),
        )
    if step.action == "MOVE_FUNDS":
        return MoveFunds(
            params.source_account_id,
            params.destination_account_id,
            Money(params.amount.currency, int(params.amount.minor_units)),
        )
    if step.action == "FX_CONVERT":
        return FxConvert(
            params.source_account_id,
            params.destination_account_id,
            Money(params.source_money.currency, int(params.source_money.minor_units)),
            params.target_currency,
            params.quote_id,
        )
    raise AssertionError(f"Unsupported C3B action: {step.action}")


def assert_plan_invariants(goal, snapshot, result, hard_rules=()):
    assert result.status == "SAT"
    original = snapshot.model_dump(mode="json", by_alias=True)
    state = SimulatedState.from_snapshot(snapshot)
    operations = []
    seen = set()
    for index, step in enumerate(result.plan.steps):
        assert step.action in {"TRANSFER", "MOVE_FUNDS", "FX_CONVERT"}
        assert step.sequence == index
        assert set(step.depends_on) <= seen
        seen.add(step.id)
        operation = _operation(step)
        assert PolicyEngine().evaluate(state, operation).allowed
        transition = apply_operation(state, operation)
        assert transition.success, transition.violations
        assert transition.state.digest() != state.digest()
        state = transition.state
        operations.append(operation)
    assert evaluate_constraints(goal, snapshot, state, tuple(operations), hard_rules).valid
    final = state.to_snapshot()
    assert result.plan.projected_outcome.goal_satisfied
    assert {
        item.account_id: (item.money.currency, item.money.minor_units)
        for item in result.plan.projected_outcome.projected_available_balances
    } == {item.id: (item.currency, item.available_minor_units) for item in final.accounts}
    assert {item.quote_id for item in operations if isinstance(item, FxConvert)} == set(
        result.plan.validity.required_quote_ids
    )
    if result.plan.validity.required_quote_ids:
        expiry = min(
            item.expires_at
            for item in snapshot.fx_quotes
            if item.id in result.plan.validity.required_quote_ids
        )
        assert result.plan.validity.valid_until <= expiry
    if goal.goal.type == "DELIVER_MONEY":
        last = operations[-1]
        assert isinstance(last, Transfer)
        assert last.beneficiary_id == goal.goal.recipient_id
        assert last.amount.currency == goal.goal.amount.currency
        assert last.amount.minor_units == int(goal.goal.amount.minor_units)
    assert snapshot.model_dump(mode="json", by_alias=True) == original


def test_plan_invariants_for_fx_and_persistent_rules():
    goal, snapshot = fixture()
    rule = hard("EXCLUDED_ACCOUNT", accountId="unused")
    result = compile_goal(goal, snapshot, (rule,))
    assert_plan_invariants(goal, snapshot, result, (rule,))
    assert result.plan.steps[0].action == "FX_CONVERT"
    assert result.plan.steps[-1].action == "TRANSFER"


def test_identical_quotes_are_materially_equivalent_and_tie_break_stably():
    goal, snapshot = fixture()
    equivalent = deepcopy(snapshot.fx_quotes[0])
    equivalent.id = "zzz-equivalent"
    snapshot.fx_quotes.append(equivalent)
    outputs = [compile_goal(goal, snapshot) for _ in range(20)]
    assert all(output == outputs[0] for output in outputs)
    assert outputs[0].status == "SAT"
    assert outputs[0].plan.steps[0].parameters.quote_id == "quote-sgd-usd-1"
    assert_plan_invariants(goal, snapshot, outputs[0])


def test_material_equivalence_ignores_commuting_move_order():
    goal, snapshot = fixture()
    snapshot.accounts.clear()
    for name, balance in (("a", 100), ("b", 100), ("c", 0), ("d", 0)):
        account(snapshot, name, "SGD", balance, ["SEND_TRANSFER", "RECEIVE_TRANSFER"])
    first = MoveFunds("a", "c", Money("SGD", 10))
    second = MoveFunds("b", "d", Money("SGD", 10))

    def node(route):
        state = SimulatedState.from_snapshot(snapshot)
        for operation in route:
            transition = apply_operation(state, operation)
            assert transition.success
            state = transition.state
        return SearchNode(state, route)

    assert plans_materially_equivalent(snapshot, node((first, second)), node((second, first)))


def test_materially_different_sources_remain_ambiguous():
    goal, snapshot = fixture()
    goal.goal.amount.currency = "SGD"
    goal.goal.amount.minor_units = "1"
    snapshot.accounts.clear()
    account(snapshot, "a", "SGD", 2, ["SEND_TRANSFER"])
    account(snapshot, "b", "SGD", 2, ["SEND_TRANSFER"])
    result = compile_goal(goal, snapshot)
    assert result.status == "UNSAT"
    assert result.reason.code == "AMBIGUOUS_VALID_PLANS"


def test_preferred_account_and_cheapest_route_yield_to_hard_rules():
    goal, snapshot = fixture()
    goal.goal.amount.currency = "SGD"
    goal.goal.amount.minor_units = "100"
    snapshot.accounts.clear()
    account(snapshot, "preferred", "SGD", 100, ["SEND_TRANSFER"])
    account(snapshot, "allowed", "SGD", 200, ["SEND_TRANSFER"])
    preference(goal, {"type": "PREFER_ACCOUNT", "accountId": "preferred"})
    constraint(
        goal,
        {
            "type": "MIN_AVAILABLE_BALANCE",
            "accountId": "preferred",
            "money": {"currency": "SGD", "minorUnits": "50"},
        },
    )
    result = compile_goal(goal, snapshot)
    assert result.status == "SAT"
    assert result.plan.steps[0].parameters.source_account_id == "allowed"
    assert_plan_invariants(goal, snapshot, result)
    goal.preferences.clear()
    preference(goal, {"type": "MINIMIZE_TOTAL_COST"})
    rule = hard("EXCLUDED_ACCOUNT", accountId="preferred")
    result = compile_goal(goal, snapshot, (rule,))
    assert result.status == "SAT"
    assert result.plan.steps[0].parameters.source_account_id == "allowed"


def test_exclusion_reason_and_diagnostic_pruning_counts():
    goal, snapshot = fixture()
    goal.goal.amount.currency = "SGD"
    goal.goal.amount.minor_units = "100"
    snapshot.accounts.clear()
    account(snapshot, "excluded", "SGD", 1000, ["SEND_TRANSFER"])
    constraint(goal, {"type": "EXCLUDED_ACCOUNT", "accountId": "excluded"})
    result = compile_with_diagnostics(goal, snapshot)
    assert result.result.status == "UNSAT"
    assert result.result.reason.code == "EXCLUDED_ACCOUNT_PREVENTS_ROUTE"
    assert result.diagnostics.pruned_by_constraint > 0
    goal.constraints.clear()
    snapshot.service_availability.transfers = False
    result = compile_with_diagnostics(goal, snapshot)
    assert result.result.status == "POLICY_BLOCKED"
    assert result.diagnostics.pruned_by_policy > 0


def test_quote_expiry_boundary_and_no_fx_destination():
    goal, snapshot = fixture()
    snapshot.fx_quotes[0].expires_at = snapshot.captured_at
    assert compile_goal(goal, snapshot).reason.code == "QUOTE_EXPIRED"
    snapshot.fx_quotes[0].expires_at = snapshot.captured_at.replace(
        year=snapshot.captured_at.year + 1
    )
    snapshot.accounts = [item for item in snapshot.accounts if item.currency == "SGD"]
    result = compile_goal(goal, snapshot)
    assert result.status == "UNSAT"
    assert result.reason.code == "NO_ELIGIBLE_DESTINATION_ACCOUNT"


def test_state_budget_and_depth_bound_fail_closed():
    goal, snapshot = fixture()
    limited = compile_with_diagnostics(goal, snapshot, max_states=1)
    assert limited.result.status == "UNSAT"
    assert limited.result.reason.code == "MAX_STATES_EXPLORED"
    assert limited.diagnostics.states_explored == 1
    assert limited.diagnostics.states_limited
    assert limited.diagnostics.candidate_actions_evaluated > 0
    assert limited.diagnostics.valid_plans_found == 0
    assert compile_goal(goal, snapshot, max_depth=1).reason.code == "SEARCH_DEPTH_EXHAUSTED"
    assert compile_goal(goal, snapshot, max_depth=2).status == "SAT"


def test_duplicate_candidates_tiny_amount_and_services():
    goal, snapshot = fixture()
    snapshot.fx_quotes.append(deepcopy(snapshot.fx_quotes[0]))
    candidates = enumerate_candidates(goal, snapshot)
    assert len(candidates) == len(set(candidates))
    assert all(
        getattr(item, "amount", getattr(item, "from_amount", None)).minor_units > 0
        for item in candidates
    )
    goal.goal.amount.minor_units = "1"
    snapshot.accounts[1].available_minor_units = "1"
    snapshot.accounts[1].ledger_minor_units = "1"
    preference(goal, {"type": "FASTEST"})
    assert_plan_invariants(goal, snapshot, compile_goal(goal, snapshot))
    snapshot.service_availability.transfers = False
    assert compile_goal(goal, snapshot).status == "POLICY_BLOCKED"


def test_many_accounts_and_circular_moves_stop_at_state_guard():
    goal, snapshot = fixture()
    goal.goal.amount.currency = "SGD"
    goal.goal.amount.minor_units = "1000"
    snapshot.accounts.clear()
    for index in range(12):
        account(snapshot, f"account-{index:02d}", "SGD", 100, ["SEND_TRANSFER", "RECEIVE_TRANSFER"])
    result = compile_with_diagnostics(goal, snapshot, max_depth=5, max_states=20)
    assert result.result.status == "UNSAT"
    assert result.result.reason.code == "MAX_STATES_EXPLORED"
    assert result.diagnostics.states_explored == 20
    assert result.diagnostics.pruned_visited_states >= 0
    assert result.diagnostics.solver_calls == 0


def test_plan_hash_matches_canonical_payload():
    goal, snapshot = fixture()
    plan = compile_goal(goal, snapshot).plan
    payload = plan.model_dump(mode="json", by_alias=True, exclude_none=True)
    actual = payload.pop("planHash")
    expected = hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    ).hexdigest()
    assert actual == expected
