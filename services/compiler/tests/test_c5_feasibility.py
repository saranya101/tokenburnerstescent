"""C5 replanning, explanation, exact relaxation, and integer amount bounds."""

from copy import deepcopy
from datetime import timedelta

from test_planner_c3a import account, constraint, fixture, hard

from app.planner.compiler import compile_goal
from app.relaxation import analyze_request_relaxations, find_max_feasible_amount
from app.replanning import explain_unsat, replan_goal


def direct_case():
    goal, state = fixture()
    state.accounts.clear()
    account(state, "original", "USD", 600000, ["SEND_TRANSFER"])
    return goal, state, compile_goal(goal, state).plan


def test_existing_plan_remains_valid():
    goal, state, plan = direct_case()
    result = replan_goal(goal, plan, state)
    assert result.status == "PLAN_STILL_VALID"
    assert result.plan == plan
    assert result.compiler_calls == 0


def test_replan_after_balance_change_preserves_target_and_is_deterministic():
    goal, state, plan = direct_case()
    changed = deepcopy(state)
    changed.state_version += 1
    changed.accounts[0].available_minor_units = "0"
    changed.accounts[0].ledger_minor_units = "0"
    account(changed, "alternative", "USD", 600000, ["SEND_TRANSFER"])
    outputs = [replan_goal(goal, plan, changed) for _ in range(3)]
    assert all(item == outputs[0] for item in outputs)
    result = outputs[0]
    assert result.status == "REPLANNED"
    assert result.plan.steps[-1].parameters.beneficiary_id == goal.goal.recipient_id
    assert result.plan.steps[-1].parameters.amount == goal.goal.amount
    assert any(item.field == "sourceAccount" for item in result.differences)
    assert any(item.code == "SOURCE_ACCOUNT_CHANGED" for item in result.differences)
    assert result.plan.plan_hash != plan.plan_hash


def test_expired_fx_quote_replans_to_new_quote():
    goal, state = fixture()
    plan = compile_goal(goal, state).plan
    changed = deepcopy(state)
    changed.state_version += 1
    changed.captured_at = changed.fx_quotes[0].expires_at
    replacement = deepcopy(changed.fx_quotes[0])
    replacement.id = "new-quote"
    replacement.expires_at += timedelta(minutes=5)
    changed.fx_quotes.append(replacement)
    result = replan_goal(goal, plan, changed)
    assert result.status == "REPLANNED"
    assert result.plan.steps[0].parameters.quote_id == "new-quote"
    assert any(item.field == "quoteIds" for item in result.differences)
    assert any(item.code == "FX_QUOTE_CHANGED" for item in result.differences)


def test_no_alternate_route_is_goal_unsat():
    goal, state, plan = direct_case()
    changed = deepcopy(state)
    changed.state_version += 1
    changed.accounts[0].available_minor_units = "0"
    changed.accounts[0].ledger_minor_units = "0"
    result = replan_goal(goal, plan, changed)
    assert result.status == "GOAL_UNSAT"
    assert result.reason.code == "INSUFFICIENT_FUNDS"
    assert result.explanation.classification == "UNSAT"


def test_policy_failure_is_not_relaxed_or_reclassified_as_financial_unsat():
    goal, state, plan = direct_case()
    state.service_availability.transfers = False
    result = replan_goal(goal, plan, state)
    assert result.status == "POLICY_BLOCKED"
    explanation = explain_unsat(goal, state)
    assert explanation.classification == "POLICY_BLOCKED"
    assert analyze_request_relaxations(goal, state).status == "POLICY_BLOCKED"
    state.service_availability.transfers = True
    state.beneficiaries[0].status = "BLOCKED"
    assert replan_goal(goal, plan, state).status == "POLICY_BLOCKED"


def test_structured_unsat_explanations_and_secondary_evidence():
    goal, state, _ = direct_case()
    state.accounts[0].available_minor_units = "1"
    state.accounts[0].ledger_minor_units = "1"
    explanation = explain_unsat(goal, state)
    assert explanation.primary.code == "INSUFFICIENT_FUNDS"
    assert explanation.classification == "UNSAT"
    goal, state, _ = direct_case()
    constraint(
        goal,
        {"type": "MIN_AVAILABLE_BALANCE", "money": {"currency": "USD", "minorUnits": "200000"}},
    )
    assert explain_unsat(goal, state).primary.code == "MIN_AVAILABLE_BALANCE_VIOLATED"
    goal, state, _ = direct_case()
    constraint(goal, {"type": "EXCLUDED_ACCOUNT", "accountId": "original"})
    assert explain_unsat(goal, state).primary.code == "EXCLUDED_ACCOUNT_PREVENTS_ROUTE"
    goal, state = fixture()
    state.fx_quotes.clear()
    assert explain_unsat(goal, state).primary.code == "NO_FX_ROUTE"


def test_max_total_cost_relaxation_exact_minor_unit_boundary():
    goal, state = fixture()
    constraint(
        goal, {"type": "MAX_TOTAL_COST", "money": {"currency": "SGD", "minorUnits": "666765"}}
    )
    original = goal.model_dump(mode="json", by_alias=True)
    result = analyze_request_relaxations(goal, state)
    assert result.status == "RELAXATION_FOUND"
    fact = result.facts[0]
    assert fact.constraint_type == "MAX_TOTAL_COST"
    assert fact.hypothetical_value.minor_units == "666766"
    assert result.diagnostics.compiler_calls >= 2
    assert goal.model_dump(mode="json", by_alias=True) == original
    below = goal.model_copy(deep=True)
    below.constraints[0].money.minor_units = "666765"
    exact = goal.model_copy(deep=True)
    exact.constraints[0].money.minor_units = "666766"
    assert compile_goal(below, state).status == "UNSAT"
    assert compile_goal(exact, state).status == "SAT"


def test_request_reserve_relaxation_exact_direction_and_persistent_guard():
    goal, state = fixture()
    goal.goal.amount.currency = "SGD"
    goal.goal.amount.minor_units = "500000"
    state.accounts.clear()
    account(state, "only", "SGD", 800000, ["SEND_TRANSFER"])
    constraint(
        goal,
        {"type": "MIN_AVAILABLE_BALANCE", "money": {"currency": "SGD", "minorUnits": "400000"}},
    )
    original = state.model_dump(mode="json", by_alias=True)
    result = analyze_request_relaxations(goal, state)
    assert result.facts[0].hypothetical_value.minor_units == "300000"
    assert result.facts[0].value_role == "maximumFeasibleValue"
    exact = goal.model_copy(deep=True)
    exact.constraints[0].money.minor_units = "300000"
    above = goal.model_copy(deep=True)
    above.constraints[0].money.minor_units = "300001"
    assert compile_goal(exact, state).status == "SAT"
    assert compile_goal(above, state).status == "UNSAT"
    persistent = hard("MIN_AVAILABLE_BALANCE", money={"currency": "SGD", "minorUnits": "400000"})
    assert analyze_request_relaxations(goal, state, (persistent,)).facts == ()
    assert state.model_dump(mode="json", by_alias=True) == original


def test_persistent_exclusion_has_no_relaxation():
    goal, state, _ = direct_case()
    rule = hard("EXCLUDED_ACCOUNT", accountId="original")
    result = analyze_request_relaxations(goal, state, (rule,))
    assert result.status == "NO_REQUEST_RELAXATION"
    assert result.facts == ()


def test_maximum_feasible_amount_exact_boundary_and_zero():
    goal, state = fixture()
    goal.goal.amount.currency = "SGD"
    goal.goal.amount.minor_units = "2000000"
    state.accounts.clear()
    account(state, "only", "SGD", 200000, ["SEND_TRANSFER"])
    constraint(
        goal, {"type": "MIN_AVAILABLE_BALANCE", "money": {"currency": "SGD", "minorUnits": "35000"}}
    )
    before_goal = goal.model_dump(mode="json", by_alias=True)
    before_state = state.model_dump(mode="json", by_alias=True)
    result = find_max_feasible_amount(goal, state, 2000000)
    assert result.status == "FEASIBLE"
    assert result.maximum_feasible_amount.minor_units == "165000"
    assert result.diagnostics.relaxation_iterations < 30
    exact = goal.model_copy(deep=True)
    exact.goal.amount.minor_units = "165000"
    above = goal.model_copy(deep=True)
    above.goal.amount.minor_units = "165001"
    assert compile_goal(exact, state).status == "SAT"
    assert compile_goal(above, state).status == "UNSAT"
    assert goal.model_dump(mode="json", by_alias=True) == before_goal
    assert state.model_dump(mode="json", by_alias=True) == before_state
    state.accounts[0].available_minor_units = "0"
    state.accounts[0].ledger_minor_units = "0"
    assert find_max_feasible_amount(goal, state, 2000000).status == "ZERO_FEASIBLE"


def test_relaxation_is_deterministic_and_fails_closed_on_call_bound():
    goal, state = fixture()
    constraint(
        goal, {"type": "MAX_TOTAL_COST", "money": {"currency": "SGD", "minorUnits": "666765"}}
    )
    assert analyze_request_relaxations(goal, state) == analyze_request_relaxations(goal, state)
    assert (
        analyze_request_relaxations(goal, state, max_compiler_calls=1).status == "CANNOT_PROVE_SAFE"
    )
