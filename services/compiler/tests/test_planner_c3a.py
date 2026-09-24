"""C3A route discovery, constraints, policy, determinism, and bounds."""

from copy import deepcopy
from pathlib import Path

from pydantic import TypeAdapter

from app.models.contracts import (
    AccountV1,
    BankStateSnapshotV1,
    GoalContractV1,
    GroundedGoalConstraintV1,
    GroundedPreferenceV1,
    HardRule,
)
from app.planner.compiler import compile_goal, compile_with_diagnostics
from app.policy.engine import PolicyEngine

FIXTURES = Path(__file__).resolve().parents[3] / "packages/contracts/fixtures"


def fixture(folder="01-ntu-transfer"):
    goal = GoalContractV1.model_validate_json(
        (FIXTURES / folder / "goal-contract.json").read_text()
    )
    state = BankStateSnapshotV1.model_validate_json(
        (FIXTURES / folder / "bank-state.json").read_text()
    )
    goal.constraints = []
    goal.preferences = []
    return goal, state


def account(state, account_id, currency, available, capabilities, status="ACTIVE"):
    state.accounts.append(
        AccountV1.model_validate(
            {
                "id": account_id,
                "type": "WALLET",
                "currency": currency,
                "ledgerMinorUnits": str(available),
                "availableMinorUnits": str(available),
                "status": status,
                "capabilities": capabilities,
            }
        )
    )


def constraint(goal, item):
    goal.constraints.append(TypeAdapter(GroundedGoalConstraintV1).validate_python(item))


def preference(goal, item):
    goal.preferences.append(TypeAdapter(GroundedPreferenceV1).validate_python(item))


def hard(kind, **values):
    return TypeAdapter(HardRule).validate_python(
        {
            "schemaVersion": "1",
            "id": "rule-1",
            "userId": "user-1",
            "type": kind,
            "enabled": True,
            **values,
        }
    )


def actions(result):
    assert result.status == "SAT", result.model_dump(mode="json", by_alias=True)
    return [step.action for step in result.plan.steps]


def test_direct_transfer_and_deterministic_plan():
    goal, state = fixture()
    state.accounts[1].available_minor_units = "600000"
    state.accounts[1].ledger_minor_units = "600000"
    state.accounts[0].available_minor_units = "0"
    state.accounts[0].ledger_minor_units = "0"
    before = deepcopy(state.model_dump(mode="json"))
    first = compile_goal(goal, state)
    second = compile_goal(goal, state)
    assert actions(first) == ["TRANSFER"]
    assert first == second
    assert first.plan.plan_hash == second.plan.plan_hash
    assert [step.id for step in first.plan.steps] == [step.id for step in second.plan.steps]
    assert first.plan.validity.required_quote_ids == []
    assert first.plan.validity.valid_until is None
    assert state.model_dump(mode="json") == before


def test_fx_then_transfer_discovered_from_golden_fixture():
    goal, state = fixture()
    result = compile_goal(goal, state)
    assert actions(result) == ["FX_CONVERT", "TRANSFER"]
    fx, transfer = result.plan.steps
    assert fx.parameters.destination_account_id == transfer.parameters.source_account_id
    assert fx.parameters.source_account_id == "acc-sgd"
    assert result.plan.validity.required_quote_ids == ["quote-sgd-usd-1"]
    assert result.plan.validity.valid_until == state.fx_quotes[0].expires_at
    assert transfer.depends_on == [fx.id]
    assert result.plan.projected_outcome.goal_satisfied
    assert result.plan.projected_outcome.delivered_money == goal.goal.amount


def test_move_then_transfer_is_discovered():
    goal, state = fixture()
    goal.goal.amount.currency = "SGD"
    goal.goal.amount.minor_units = "500000"
    state.accounts.clear()
    account(state, "source-a", "SGD", 300000, ["SEND_TRANSFER"])
    account(state, "source-b", "SGD", 250000, ["SEND_TRANSFER", "RECEIVE_TRANSFER"])
    result = compile_goal(goal, state)
    assert actions(result) == ["MOVE_FUNDS", "TRANSFER"]
    assert result.plan.steps[0].parameters.destination_account_id == "source-b"
    assert result.plan.steps[1].parameters.source_account_id == "source-b"


def test_move_fx_transfer_is_discovered():
    goal, state = fixture()
    state.accounts[0].available_minor_units = "0"
    state.accounts[0].ledger_minor_units = "0"
    state.accounts[0].capabilities.append("RECEIVE_TRANSFER")
    account(state, "funding-sgd", "SGD", 800000, ["SEND_TRANSFER"])
    result = compile_goal(goal, state)
    assert actions(result) == ["MOVE_FUNDS", "FX_CONVERT", "TRANSFER"]
    assert result.plan.steps[0].parameters.destination_account_id == "acc-sgd"
    assert result.plan.steps[1].parameters.source_account_id == "acc-sgd"
    assert result.plan.steps[2].parameters.source_account_id == "acc-usd"


def test_grounded_move_funds_goal():
    goal, state = fixture("05-balance-changed")
    goal.goal.amount.minor_units = "10000"
    result = compile_goal(goal, state)
    assert actions(result) == ["MOVE_FUNDS"]
    assert result.plan.projected_outcome.delivered_money is None
    assert result.plan.projected_outcome.goal_satisfied


def test_excluded_funding_account_and_persistent_rule():
    goal, state = fixture()
    goal.goal.amount.currency = "SGD"
    goal.goal.amount.minor_units = "100000"
    state.accounts.clear()
    account(state, "excluded", "SGD", 900000, ["SEND_TRANSFER"])
    account(state, "allowed", "SGD", 200000, ["SEND_TRANSFER"])
    rule = hard("EXCLUDED_ACCOUNT", accountId="excluded")
    result = compile_goal(goal, state, (rule,))
    assert actions(result) == ["TRANSFER"]
    assert result.plan.steps[0].parameters.source_account_id == "allowed"
    constraint(goal, {"type": "EXCLUDED_ACCOUNT", "accountId": "allowed"})
    assert compile_goal(goal, state, (rule,)).status == "UNSAT"


def test_reserve_and_maximum_cost():
    goal, state = fixture()
    constraint(
        goal,
        {"type": "MIN_AVAILABLE_BALANCE", "money": {"currency": "SGD", "minorUnits": "400000"}},
    )
    assert compile_goal(goal, state).reason.code == "MIN_AVAILABLE_BALANCE_VIOLATED"
    goal.constraints.clear()
    constraint(
        goal, {"type": "MAX_TOTAL_COST", "money": {"currency": "SGD", "minorUnits": "666765"}}
    )
    assert compile_goal(goal, state).reason.code == "MAX_TOTAL_COST_TOO_LOW"
    goal.constraints.clear()
    constraint(
        goal, {"type": "MAX_TOTAL_COST", "money": {"currency": "SGD", "minorUnits": "666766"}}
    )
    assert actions(compile_goal(goal, state)) == ["FX_CONVERT", "TRANSFER"]


def test_insufficient_funds_and_missing_routes():
    goal, state = fixture()
    state.accounts[0].available_minor_units = "100"
    state.accounts[0].ledger_minor_units = "100"
    result = compile_goal(goal, state)
    assert result.status == "UNSAT"
    assert result.reason.code in {"INSUFFICIENT_FUNDS", "NO_TRANSFER_ROUTE"}
    state.fx_quotes.clear()
    assert compile_goal(goal, state).reason.code == "NO_FX_ROUTE"


def test_transfer_and_fx_service_unavailable():
    goal, state = fixture()
    state.service_availability.transfers = False
    result = compile_goal(goal, state)
    assert result.status == "POLICY_BLOCKED"
    assert result.reason.code == "REQUIRED_SERVICE_UNAVAILABLE"
    state.service_availability.transfers = True
    state.service_availability.fx = False
    result = compile_goal(goal, state)
    assert result.status == "POLICY_BLOCKED"
    assert result.reason.code == "REQUIRED_SERVICE_UNAVAILABLE"


def test_expired_quote_and_blocked_beneficiary():
    goal, state = fixture()
    state.fx_quotes[0].expires_at = state.captured_at
    result = compile_goal(goal, state)
    assert result.status == "UNSAT"
    assert result.reason.code == "QUOTE_EXPIRED"
    state.beneficiaries[0].status = "BLOCKED"
    result = compile_goal(goal, state)
    assert result.status == "POLICY_BLOCKED"
    assert result.reason.code == "BENEFICIARY_BLOCKED"
    state.beneficiaries[0].status = "PENDING_VERIFICATION"
    assert compile_goal(goal, state).reason.code == "BENEFICIARY_UNVERIFIED"


def test_minimize_fx_and_prefer_account():
    goal, state = fixture()
    state.accounts[1].available_minor_units = "600000"
    state.accounts[1].ledger_minor_units = "600000"
    account(state, "empty-usd", "USD", 0, ["SEND_TRANSFER", "RECEIVE_TRANSFER"])
    preference(goal, {"type": "MINIMIZE_FX"})
    preference(goal, {"type": "FASTEST"})
    result = compile_goal(goal, state)
    assert actions(result) == ["TRANSFER"]
    goal.preferences.clear()
    account(state, "preferred-usd", "USD", 600000, ["SEND_TRANSFER"])
    preference(goal, {"type": "PREFER_ACCOUNT", "accountId": "preferred-usd"})
    preference(goal, {"type": "FASTEST"})
    result = compile_goal(goal, state)
    assert actions(result) == ["TRANSFER"]
    assert result.plan.steps[0].parameters.source_account_id == "preferred-usd"


def test_fastest_preference_and_policy_allowlist():
    goal, state = fixture()
    state.accounts[1].available_minor_units = "600000"
    state.accounts[1].ledger_minor_units = "600000"
    account(state, "empty-usd", "USD", 0, ["SEND_TRANSFER", "RECEIVE_TRANSFER"])
    preference(goal, {"type": "FASTEST"})
    assert actions(compile_goal(goal, state)) == ["TRANSFER"]
    blocked = compile_goal(
        goal, state, policy=PolicyEngine(frozenset({"MOVE_FUNDS", "FX_CONVERT"}))
    )
    assert blocked.status == "POLICY_BLOCKED"
    assert blocked.reason.code == "OPERATION_NOT_ALLOWED"


def test_minimize_total_cost_uses_quote_fees():
    goal, state = fixture()
    state.fx_quotes.append(deepcopy(state.fx_quotes[0]))
    state.fx_quotes[1].id = "quote-expensive"
    state.fx_quotes[1].fee.minor_units = "1000"
    preference(goal, {"type": "MINIMIZE_TOTAL_COST"})
    constraint(
        goal, {"type": "MAX_TOTAL_COST", "money": {"currency": "SGD", "minorUnits": "700000"}}
    )
    result = compile_goal(goal, state)
    assert actions(result) == ["FX_CONVERT", "TRANSFER"]
    assert result.plan.steps[0].parameters.quote_id == "quote-sgd-usd-1"


def test_no_preference_material_choice_returns_structured_ambiguity():
    goal, state = fixture()
    goal.goal.amount.currency = "SGD"
    goal.goal.amount.minor_units = "100"
    state.accounts.clear()
    account(state, "a", "SGD", 1000, ["SEND_TRANSFER"])
    account(state, "b", "SGD", 1000, ["SEND_TRANSFER"])
    result = compile_goal(goal, state)
    assert result.status == "UNSAT"
    assert result.reason.code == "AMBIGUOUS_VALID_PLANS"
    assert result.reason.details["candidateCount"] >= 2


def test_depth_limit_loop_prevention_and_metrics():
    goal, state = fixture()
    shallow = compile_with_diagnostics(goal, state, max_depth=1)
    assert shallow.result.status == "UNSAT"
    assert shallow.result.reason.code == "SEARCH_DEPTH_EXHAUSTED"
    assert shallow.diagnostics.states_explored <= 2
    assert shallow.diagnostics.candidate_actions_evaluated > 0
    assert shallow.diagnostics.solver_calls == 0
    assert shallow.diagnostics.search_depth_reached == 1
    # Reversible internal moves cannot create an unbounded search.
    goal.goal.amount.currency = "SGD"
    goal.goal.amount.minor_units = "800000"
    state.accounts.clear()
    account(state, "a", "SGD", 400000, ["SEND_TRANSFER", "RECEIVE_TRANSFER"])
    account(state, "b", "SGD", 400000, ["SEND_TRANSFER", "RECEIVE_TRANSFER"])
    result = compile_with_diagnostics(goal, state, max_depth=4)
    assert result.diagnostics.states_explored < 100


def test_trade_goal_remains_unsupported():
    goal, state = fixture("02-apple-investment")
    result = compile_goal(goal, state)
    assert result.status == "UNSAT"
    assert result.reason.code == "UNSUPPORTED_GOAL"
