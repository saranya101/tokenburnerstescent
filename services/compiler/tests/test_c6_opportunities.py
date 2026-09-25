"""C6 informational liquidity and compiler-proven amount boundaries."""

from copy import deepcopy
from datetime import timedelta

from test_planner_c3a import account, fixture, hard

from app.models.contracts import ObligationV1
from app.opportunities import (
    available_above_reserve,
    available_after_obligations,
    discover_opportunities,
)
from app.planner.compiler import compile_goal
from app.policy.engine import PolicyEngine


def base_state(balance=620000):
    goal, state = fixture()
    state.accounts.clear()
    account(state, "spendable", "SGD", balance, ["SEND_TRANSFER", "RECEIVE_TRANSFER"])
    return goal, state


def reserve(amount=300000, account_id=None):
    values = {"money": {"currency": "SGD", "minorUnits": str(amount)}}
    if account_id is not None:
        values["accountId"] = account_id
    return hard("MIN_AVAILABLE_BALANCE", **values)


def obligation(state, name, amount, days, status="OPEN", currency="SGD"):
    state.obligations.append(
        ObligationV1.model_validate(
            {
                "id": name,
                "description": name,
                "money": {"currency": currency, "minorUnits": str(amount)},
                "dueAt": (state.captured_at + timedelta(days=days)).isoformat(),
                "status": status,
            }
        )
    )


def candidate(result, kind, currency="SGD"):
    return next(
        item for item in result.candidates if item.type == kind and item.currency == currency
    )


def test_above_reserve_positive_equal_and_below():
    _, state = base_state(620000)
    rule = reserve()
    assert available_above_reserve(state, (rule,), "SGD").safe_minor_units == 320000
    state.accounts[0].available_minor_units = "300000"
    state.accounts[0].ledger_minor_units = "300000"
    assert available_above_reserve(state, (rule,), "SGD").safe_minor_units == 0
    state.accounts[0].available_minor_units = "200000"
    state.accounts[0].ledger_minor_units = "200000"
    assert available_above_reserve(state, (rule,), "SGD").safe_minor_units == 0


def test_excluded_frozen_and_incapable_accounts_do_not_contribute():
    _, state = base_state(100000)
    account(state, "excluded", "SGD", 900000, ["SEND_TRANSFER"])
    account(state, "frozen", "SGD", 500000, ["SEND_TRANSFER"], status="FROZEN")
    account(state, "no-out", "SGD", 600000, ["RECEIVE_TRANSFER"])
    rule = hard("EXCLUDED_ACCOUNT", accountId="excluded")
    fact = available_above_reserve(state, (rule,), "SGD")
    assert fact.available_minor_units == 100000
    assert fact.safe_minor_units == 100000
    assert fact.accounts_considered == 1
    assert rule.id in fact.constraints_applied


def test_account_specific_and_global_reserves_are_conservative():
    _, state = base_state(200000)
    account(state, "second", "SGD", 100000, ["SEND_TRANSFER"])
    fact = available_above_reserve(state, (reserve(150000, "spendable"),), "SGD")
    assert fact.safe_minor_units == 150000
    fact = available_above_reserve(state, (reserve(150000, "spendable"), reserve(250000)), "SGD")
    assert fact.safe_minor_units == 50000


def test_obligations_exact_horizon_paid_and_overdue():
    _, state = base_state()
    obligation(state, "inside", 155000, 10)
    obligation(state, "outside", 50000, 40)
    obligation(state, "paid", 90000, 2, "PAID")
    liquidity, considered, after = available_after_obligations(state, (reserve(),), "SGD")
    assert liquidity.safe_minor_units == 320000
    assert considered.count == 1
    assert considered.amount_minor_units == 155000
    assert after == 165000
    obligation(state, "overdue", 50000, -2, "OVERDUE")
    _, considered, after = available_after_obligations(state, (reserve(),), "SGD")
    assert considered.amount_minor_units == 205000
    assert after == 115000
    _, considered, after = available_after_obligations(state, (reserve(),), "SGD", 5)
    assert considered.amount_minor_units == 50000
    assert after == 270000


def test_obligations_consume_discretionary_amount_and_mixed_currency_fails_closed():
    _, state = base_state(320000)
    obligation(state, "bill", 50000, 2)
    _, _, after = available_after_obligations(state, (reserve(),), "SGD")
    assert after == 0
    obligation(state, "foreign", 100, 2, currency="USD")
    _, obligations, after = available_after_obligations(state, (reserve(),), "SGD")
    assert obligations.status == "CANNOT_PROVE_SAFE"
    assert obligations.reason == "MIXED_CURRENCY_OBLIGATIONS"
    assert after is None
    result = discover_opportunities(state, (reserve(),))
    assert not any(item.type == "AVAILABLE_AFTER_OBLIGATIONS" for item in result.candidates)
    assert "MIXED_CURRENCY_OBLIGATIONS" in result.diagnostics.rejection_reasons


def test_emergency_reserve_gap_and_no_invented_target():
    _, state = base_state(240000)
    assert not any(
        item.type == "EMERGENCY_RESERVE_GAP" for item in discover_opportunities(state).candidates
    )
    result = discover_opportunities(state, (reserve(),))
    gap = candidate(result, "EMERGENCY_RESERVE_GAP")
    assert gap.status == "RESERVE_SHORTFALL"
    assert gap.amount_minor_units == "60000"
    state.accounts[0].available_minor_units = "320000"
    state.accounts[0].ledger_minor_units = "320000"
    assert (
        candidate(discover_opportunities(state, (reserve(),)), "EMERGENCY_RESERVE_GAP").status
        == "RESERVE_FULLY_FUNDED"
    )


def test_obligation_coverage_full_partial_and_protected_reserve():
    _, state = base_state(620000)
    obligation(state, "bill", 155000, 5)
    full = candidate(discover_opportunities(state, (reserve(),)), "UPCOMING_OBLIGATION_COVERAGE")
    assert full.status == "FULLY_COVERED"
    assert dict(full.facts)["shortfallMinorUnits"] == "0"
    state.accounts[0].available_minor_units = "400000"
    state.accounts[0].ledger_minor_units = "400000"
    partial = candidate(discover_opportunities(state, (reserve(),)), "UPCOMING_OBLIGATION_COVERAGE")
    assert partial.status == "PARTIALLY_COVERED"
    assert partial.amount_minor_units == "100000"
    assert dict(partial.facts)["shortfallMinorUnits"] == "55000"
    state.accounts[0].available_minor_units = "300000"
    state.accounts[0].ledger_minor_units = "300000"
    assert (
        candidate(
            discover_opportunities(state, (reserve(),)), "UPCOMING_OBLIGATION_COVERAGE"
        ).status
        == "NOT_COVERED"
    )


def test_goal_amount_feasibility_reuses_c5_and_exact_compiler_boundary():
    goal, state = base_state(200000)
    goal.goal.amount.currency = "SGD"
    goal.goal.amount.minor_units = "200000"
    original = goal.model_dump(mode="json", by_alias=True)
    result = discover_opportunities(
        state,
        (reserve(35000),),
        goal_templates=(goal,),
        template_types=("GOAL_AMOUNT_FEASIBILITY",),
    )
    maximum = candidate(result, "GOAL_AMOUNT_FEASIBILITY")
    assert maximum.amount_minor_units == "165000"
    assert maximum.feasibility_proven
    assert result.diagnostics.compiler_calls > 0
    assert result.diagnostics.feasibility_search_iterations > 0
    exact = goal.model_copy(deep=True)
    exact.goal.amount.minor_units = maximum.amount_minor_units
    above = goal.model_copy(deep=True)
    above.goal.amount.minor_units = str(int(maximum.amount_minor_units) + 1)
    assert compile_goal(exact, state, (reserve(35000),)).status == "SAT"
    assert compile_goal(above, state, (reserve(35000),)).status == "UNSAT"
    assert goal.model_dump(mode="json", by_alias=True) == original


def test_accounting_amount_is_suppressed_when_template_cannot_compile_it():
    goal, state = base_state(500)
    goal.goal.amount.currency = "SGD"
    goal.goal.amount.minor_units = "1000"
    state.accounts[0].capabilities = ["SEND_TRANSFER"]
    account(state, "second", "SGD", 500, ["SEND_TRANSFER"])
    result = discover_opportunities(
        state, goal_templates=(goal,), template_types=("AVAILABLE_ABOVE_RESERVE",)
    )
    assert not result.candidates
    assert "ACCOUNTING_AMOUNT_NOT_COMPILER_FEASIBLE" in result.diagnostics.rejection_reasons


def test_fx_feasibility_uses_quote_and_caps_expiry():
    goal, state = fixture()
    state.accounts[0].available_minor_units = "620000"
    state.accounts[0].ledger_minor_units = "620000"
    state.accounts[1].available_minor_units = "0"
    state.accounts[1].ledger_minor_units = "0"
    result = discover_opportunities(
        state, (reserve(),), goal_templates=(goal,), template_types=("GOAL_AMOUNT_FEASIBILITY",)
    )
    maximum = candidate(result, "GOAL_AMOUNT_FEASIBILITY", "USD")
    assert int(maximum.amount_minor_units) > 0
    assert maximum.expires_at == state.fx_quotes[0].expires_at
    assert reserve().id in maximum.constraints_applied
    exact = goal.model_copy(deep=True)
    exact.goal.amount.minor_units = maximum.amount_minor_units
    above = goal.model_copy(deep=True)
    above.goal.amount.minor_units = str(int(maximum.amount_minor_units) + 1)
    assert compile_goal(exact, state, (reserve(),)).status == "SAT"
    assert compile_goal(above, state, (reserve(),)).status == "UNSAT"


def test_move_then_fx_funding_is_included_in_feasibility_bound():
    goal, state = fixture()
    state.accounts[0].available_minor_units = "0"
    state.accounts[0].ledger_minor_units = "0"
    state.accounts[0].capabilities.append("RECEIVE_TRANSFER")
    state.accounts[1].available_minor_units = "0"
    state.accounts[1].ledger_minor_units = "0"
    account(state, "movable-funding", "SGD", 800000, ["SEND_TRANSFER"])
    result = discover_opportunities(
        state, goal_templates=(goal,), template_types=("GOAL_AMOUNT_FEASIBILITY",)
    )
    maximum = candidate(result, "GOAL_AMOUNT_FEASIBILITY", "USD")
    assert maximum.feasibility_proven
    assert int(maximum.amount_minor_units) >= 500000


def test_goal_maximum_reserves_known_obligations_in_compiler_probe():
    goal, state = base_state(620000)
    goal.goal.amount.currency = "SGD"
    goal.goal.amount.minor_units = "620000"
    obligation(state, "upcoming", 155000, 5)
    result = discover_opportunities(
        state, (reserve(),), goal_templates=(goal,), template_types=("GOAL_AMOUNT_FEASIBILITY",)
    )
    maximum = candidate(result, "GOAL_AMOUNT_FEASIBILITY")
    assert maximum.amount_minor_units == "165000"
    assert "OPPORTUNITY_OBLIGATION_RESERVE" in maximum.constraints_applied
    assert dict(maximum.facts)["upcomingObligationsMinorUnits"] == "155000"


def test_exact_horizon_boundary_is_included():
    _, state = base_state()
    obligation(state, "boundary", 100, 30)
    _, fact, after = available_after_obligations(state, (), "SGD", 30)
    assert fact.count == 1
    assert after == 619900
    _, fact, after = available_after_obligations(state, (), "SGD", 29)
    assert fact.count == 0
    assert after == 620000


def test_state_binding_expiry_determinism_and_deduplication():
    _, state = base_state()
    types = ("AVAILABLE_ABOVE_RESERVE", "AVAILABLE_ABOVE_RESERVE")
    first = discover_opportunities(state, (reserve(),), template_types=types)
    assert first == discover_opportunities(state, (reserve(),), template_types=types)
    assert len(first.candidates) == 1
    item = first.candidates[0]
    assert item.state_version == state.state_version
    assert item.expires_at == state.captured_at + timedelta(minutes=60)
    changed = deepcopy(state)
    changed.state_version += 1
    assert (
        discover_opportunities(changed, (reserve(),), template_types=types)
        .candidates[0]
        .state_version
        != item.state_version
    )


def test_obligation_expiry_is_capped_by_next_due_date():
    _, state = base_state()
    state.obligations.append(
        ObligationV1.model_validate(
            {
                "id": "due-soon",
                "description": "due-soon",
                "money": {"currency": "SGD", "minorUnits": "100"},
                "dueAt": (state.captured_at + timedelta(minutes=10)).isoformat(),
                "status": "OPEN",
            }
        )
    )
    result = discover_opportunities(state)
    assert candidate(result, "AVAILABLE_ABOVE_RESERVE").expires_at == state.captured_at + timedelta(
        minutes=60
    )
    assert (
        candidate(result, "AVAILABLE_AFTER_OBLIGATIONS").expires_at == state.obligations[0].due_at
    )
    assert (
        candidate(result, "UPCOMING_OBLIGATION_COVERAGE").expires_at == state.obligations[0].due_at
    )


def test_policy_and_unknown_state_fail_closed_without_mutation():
    _, state = base_state()
    before = state.model_dump(mode="json", by_alias=True)
    rule = reserve()
    original_rule = rule.model_dump(mode="json", by_alias=True)
    blocked = discover_opportunities(
        state,
        (rule,),
        policy=PolicyEngine(frozenset()),
        template_types=("AVAILABLE_ABOVE_RESERVE",),
    )
    assert blocked.candidates == ()
    assert "REQUIRED_SERVICE_UNAVAILABLE" in blocked.diagnostics.rejection_reasons
    state.accounts[0].available_minor_units = "not-a-number"
    before_unknown = state.model_dump(mode="json", by_alias=True)
    unknown = discover_opportunities(state, (rule,), template_types=("AVAILABLE_ABOVE_RESERVE",))
    assert unknown.candidates == ()
    assert "INVALID_ACCOUNT_BALANCE" in unknown.diagnostics.rejection_reasons
    unknown_gap = discover_opportunities(state, (rule,), template_types=("EMERGENCY_RESERVE_GAP",))
    assert unknown_gap.candidates == ()
    assert "INVALID_ACCOUNT_BALANCE" in unknown_gap.diagnostics.rejection_reasons
    assert state.model_dump(mode="json", by_alias=True) == before_unknown
    assert rule.model_dump(mode="json", by_alias=True) == original_rule
    assert before["stateVersion"] == state.state_version


def test_duplicate_obligation_and_quote_identifiers_fail_closed():
    goal, state = base_state()
    obligation(state, "dup", 100, 2)
    state.obligations.append(deepcopy(state.obligations[0]))
    result = discover_opportunities(state, template_types=("AVAILABLE_AFTER_OBLIGATIONS",))
    assert result.candidates == ()
    assert "DUPLICATE_OBLIGATION_ID" in result.diagnostics.rejection_reasons
    goal, state = fixture()
    state.fx_quotes.append(deepcopy(state.fx_quotes[0]))
    result = discover_opportunities(
        state, goal_templates=(goal,), template_types=("GOAL_AMOUNT_FEASIBILITY",)
    )
    assert "DUPLICATE_QUOTE_ID" in result.diagnostics.rejection_reasons
