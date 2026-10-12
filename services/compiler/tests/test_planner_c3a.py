"""C3A route discovery, constraints, policy, determinism, and bounds."""

from copy import deepcopy
from pathlib import Path

from pydantic import TypeAdapter

from app.models.contracts import (
    AccountV1,
    BankStateSnapshotV1,
    FxQuoteV1,
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


def test_direct_sgd_transfer_to_selected_saved_payee():
    goal, state = fixture()
    goal.goal.amount.currency = "SGD"
    goal.goal.amount.minor_units = "50000"
    goal.goal.recipient_id = "ben-john-lim"
    beneficiary_binding = next(
        binding for binding in goal.entity_bindings if binding.entity_type == "BENEFICIARY"
    )
    beneficiary_binding.entity_id = "ben-john-lim"
    state.beneficiaries[0].id = "ben-john-lim"
    state.beneficiaries[0].name = "John Lim"
    state.beneficiaries[0].supported_currencies = ["SGD"]

    result = compile_goal(goal, state)

    assert actions(result) == ["TRANSFER"]
    transfer = result.plan.steps[0]
    assert transfer.parameters.beneficiary_id == "ben-john-lim"
    assert transfer.parameters.amount.currency == "SGD"
    assert transfer.parameters.amount.minor_units == "50000"


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


def test_funded_single_stock_purchase_uses_authoritative_quote_and_updates_projection():
    goal, state = fixture("02-apple-investment")
    goal.goal.budget = None
    goal.goal.quantity = "1"
    result = compile_goal(goal, state)
    assert actions(result) == ["BUY_ASSET"]
    step = result.plan.steps[0]
    assert step.parameters.model_dump(mode="json", by_alias=True) == {
        "sourceAccountId": "acc-brokerage",
        "assetId": "asset-aapl",
        "quantity": "1",
        "maximumSpend": {"currency": "USD", "minorUnits": "20100"},
        "quoteId": "asset-quote-aapl-usd-v1",
        "settlementCurrency": "USD",
        "quotedUnitPriceMinor": "20000",
        "quotedFeeMinor": "100",
        "authorizedTotalMinor": "20100",
    }
    assert result.plan.validity.required_quote_ids == ["asset-quote-aapl-usd-v1"]
    assert result.plan.validity.valid_until == state.asset_quotes[0].expires_at
    assert result.plan.projected_outcome.acquired_assets[0].asset_id == "asset-aapl"
    assert result.plan.projected_outcome.acquired_assets[0].quantity == "1"
    projected = next(
        item
        for item in result.plan.projected_outcome.projected_available_balances
        if item.account_id == "acc-brokerage"
    )
    assert projected.money.minor_units == "479900"


def test_single_stock_purchase_fails_closed_for_unavailable_asset_and_expired_quote():
    goal, state = fixture("02-apple-investment")
    goal.goal.budget = None
    goal.goal.quantity = "1"
    state.assets[0].tradable = False
    result = compile_goal(goal, state)
    assert result.status == "POLICY_BLOCKED"
    assert result.reason.code == "ASSET_NOT_TRADABLE"

    state.assets[0].tradable = True
    state.asset_quotes[0].expires_at = state.captured_at
    result = compile_goal(goal, state)
    assert result.status == "UNSAT"
    assert result.reason.code == "ASSET_PRICE_UNAVAILABLE"


def test_single_stock_purchase_requires_settled_usd_and_does_not_synthesize_fx():
    goal, state = fixture("02-apple-investment")
    goal.goal.budget = None
    goal.goal.quantity = "1"
    state.accounts[0].available_minor_units = "20000"
    state.accounts[0].ledger_minor_units = "20000"
    account(state, "acc-sgd", "SGD", 500000, ["CONVERT_FX", "SEND_TRANSFER"])
    result = compile_goal(goal, state)
    assert result.status == "UNSAT"
    assert result.reason.code == "INSUFFICIENT_FUNDS"


def fundable_apple_goal():
    goal, state = fixture("02-apple-investment")
    goal.goal.budget = None
    goal.goal.quantity = "1"
    state.accounts[0].available_minor_units = "20000"
    state.accounts[0].ledger_minor_units = "20000"
    state.accounts[0].capabilities.append("RECEIVE_TRANSFER")
    account(state, "acc-sgd", "SGD", 500000, ["CONVERT_FX", "SEND_TRANSFER"])
    state.fx_quotes.append(
        FxQuoteV1.model_validate(
            {
                "id": "quote-sgd-usd-investment",
                "fromCurrency": "SGD",
                "toCurrency": "USD",
                "rate": "0.75",
                "fee": {"currency": "SGD", "minorUnits": "50"},
                "expiresAt": "2099-01-01T00:00:00.000Z",
            }
        )
    )
    preference(goal, {"type": "PREFER_ACCOUNT", "accountId": "acc-sgd"})
    return goal, state


def test_confirmed_sgd_funding_preference_builds_one_bound_fx_purchase_plan():
    goal, state = fundable_apple_goal()
    result = compile_goal(goal, state)
    assert actions(result) == ["FX_CONVERT", "BUY_ASSET"]
    fx, purchase = result.plan.steps
    assert fx.parameters.source_account_id == "acc-sgd"
    assert fx.parameters.destination_account_id == "acc-brokerage"
    assert fx.parameters.source_money.minor_units == "133"
    assert purchase.parameters.source_account_id == "acc-brokerage"
    assert purchase.depends_on == [fx.id]
    assert result.plan.validity.required_quote_ids == [
        "asset-quote-aapl-usd-v1",
        "quote-sgd-usd-investment",
    ]


def test_confirmed_conditional_funding_and_reserve_compile_as_one_coordinated_plan():
    goal, state = fundable_apple_goal()
    constraint(
        goal,
        {
            "type": "MIN_AVAILABLE_BALANCE",
            "money": {"currency": "SGD", "minorUnits": "100000"},
            "accountId": "acc-sgd",
        },
    )
    result = compile_goal(goal, state)
    assert actions(result) == ["FX_CONVERT", "BUY_ASSET"]
    assert result.plan.steps[1].depends_on == [result.plan.steps[0].id]
    projected_sgd = next(
        item.money.minor_units
        for item in result.plan.projected_outcome.projected_available_balances
        if item.account_id == "acc-sgd"
    )
    assert int(projected_sgd) >= 100000


def test_funding_route_respects_minimum_sgd_reserve_and_source_funds():
    goal, state = fundable_apple_goal()
    constraint(
        goal,
        {
            "type": "MIN_AVAILABLE_BALANCE",
            "money": {"currency": "SGD", "minorUnits": "499818"},
            "accountId": "acc-sgd",
        },
    )
    limited = compile_goal(goal, state)
    assert limited.status == "UNSAT"
    assert limited.reason.code == "MIN_AVAILABLE_BALANCE_VIOLATED"
    assert limited.reason.details["bankStateVersion"] == state.state_version

    goal.constraints.clear()
    state.accounts[-1].available_minor_units = "183"
    state.accounts[-1].ledger_minor_units = "183"
    assert actions(compile_goal(goal, state)) == ["FX_CONVERT", "BUY_ASSET"]
    state.accounts[-1].available_minor_units = "182"
    state.accounts[-1].ledger_minor_units = "182"
    insufficient = compile_goal(goal, state)
    assert insufficient.status == "UNSAT"
    assert insufficient.reason.code == "INSUFFICIENT_FUNDING_FUNDS"


def test_funding_route_fails_before_fx_for_asset_or_quote_problems():
    goal, state = fundable_apple_goal()
    state.assets[0].tradable = False
    unavailable = compile_goal(goal, state)
    assert unavailable.status == "POLICY_BLOCKED"
    assert unavailable.reason.code == "ASSET_NOT_TRADABLE"

    state.assets[0].tradable = True
    state.fx_quotes[0].expires_at = state.captured_at
    expired = compile_goal(goal, state)
    assert expired.status == "UNSAT"
    assert expired.reason.code == "QUOTE_EXPIRED"


def test_sufficient_usd_never_adds_unnecessary_funding_fx():
    goal, state = fundable_apple_goal()
    state.accounts[0].available_minor_units = "500000"
    state.accounts[0].ledger_minor_units = "500000"
    assert actions(compile_goal(goal, state)) == ["BUY_ASSET"]


def test_sgd_reserve_without_confirmed_funding_preference_never_invents_fx_permission():
    # A reserve alone is not permission to fund an acquisition from this account.
    goal, state = fixture("02-apple-investment")
    goal.goal.budget = None
    goal.goal.quantity = "1"
    account(state, "acc-sgd", "SGD", 500000, ["CONVERT_FX", "SEND_TRANSFER"])
    constraint(
        goal,
        {
            "type": "MIN_AVAILABLE_BALANCE",
            "money": {"currency": "SGD", "minorUnits": "100000"},
            "accountId": "acc-sgd",
        },
    )
    funded = compile_goal(goal, state)
    assert actions(funded) == ["BUY_ASSET"]
    assert funded.plan.steps[0].parameters.source_account_id == "acc-brokerage"
    assert (
        next(
            item
            for item in funded.plan.projected_outcome.projected_available_balances
            if item.account_id == "acc-sgd"
        ).money.minor_units
        == "500000"
    )

    state.accounts[0].available_minor_units = "20000"
    state.accounts[0].ledger_minor_units = "20000"
    unfunded = compile_goal(goal, state)
    assert unfunded.status == "UNSAT"
    assert unfunded.reason.code == "INSUFFICIENT_FUNDS"


def test_single_stock_purchase_recompiles_material_quote_and_state_changes():
    goal, state = fixture("02-apple-investment")
    goal.goal.budget = None
    goal.goal.quantity = "1"
    first = compile_goal(goal, state)
    assert actions(first) == ["BUY_ASSET"]
    state.state_version += 1
    state.asset_quotes[0].unit_price_minor = "20100"
    second = compile_goal(goal, state)
    assert actions(second) == ["BUY_ASSET"]
    assert second.plan.bank_state_version == first.plan.bank_state_version + 1
    assert second.plan.plan_hash != first.plan.plan_hash
    assert second.plan.steps[0].parameters.authorized_total_minor == "20200"


def test_single_stock_purchase_enforces_customer_and_persistent_hard_constraints():
    goal, state = fixture("02-apple-investment")
    goal.goal.budget = None
    goal.goal.quantity = "1"
    constraint(
        goal,
        {"type": "MAX_TOTAL_COST", "money": {"currency": "USD", "minorUnits": "20100"}},
    )
    assert actions(compile_goal(goal, state)) == ["BUY_ASSET"]
    goal.constraints[0].money.minor_units = "20099"
    limited = compile_goal(goal, state)
    assert limited.status == "UNSAT"
    assert limited.reason.code == "MAX_TOTAL_COST_VIOLATED"

    goal.constraints.clear()
    excluded = compile_goal(goal, state, (hard("EXCLUDED_ACCOUNT", accountId="acc-brokerage"),))
    assert excluded.status == "UNSAT"
    assert excluded.reason.code == "EXCLUDED_ACCOUNT_USED"
