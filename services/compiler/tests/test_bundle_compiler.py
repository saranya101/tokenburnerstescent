"""C1 composite compiler, proof, determinism, and fail-closed asset coverage."""

import hashlib
import json
from copy import deepcopy
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from pydantic import TypeAdapter, ValidationError

from app.main import app
from app.models.contracts import (
    AccountV1,
    AssetQuoteV1,
    AssetV1,
    BankStateSnapshotV1,
    BundleSatisfactionProofV1,
    FinancialPlanV1,
    GoalBundleContractV1,
    GoalContractV1,
    GroundedGoalConstraintV1,
    GroundedGoalV1,
)
from app.planner.bundle import compile_goal_bundle, validate_bundle_plan
from app.planner.compiler import compile_goal

FIXTURES = Path(__file__).resolve().parents[3] / "packages/contracts/fixtures"


def fixture():
    folder = FIXTURES / "01-ntu-transfer"
    goal = GoalContractV1.model_validate_json((folder / "goal-contract.json").read_text())
    state = BankStateSnapshotV1.model_validate_json((folder / "bank-state.json").read_text())
    goal.constraints = []
    goal.preferences = []
    return goal, state


def item(item_id, goal, bindings=(), constraints=(), preferences=()):
    return {
        "itemId": item_id,
        "goal": goal.model_dump(mode="json", by_alias=True),
        "constraints": list(constraints),
        "preferences": list(preferences),
        "bindings": [binding.model_dump(mode="json", by_alias=True) for binding in bindings],
    }


def bundle(items, dependencies=(), global_constraints=(), bundle_id="bundle-1"):
    return GoalBundleContractV1.model_validate(
        {
            "schemaVersion": "1",
            "bundleId": bundle_id,
            "bundleVersion": 1,
            "items": items,
            "globalConstraints": list(global_constraints),
            "explicitDependencies": list(dependencies),
            "contractHash": "a" * 64,
        }
    )


def direct_state(goal, state, available="1000000"):
    state.accounts[0].available_minor_units = "0"
    state.accounts[0].ledger_minor_units = "0"
    state.accounts[1].available_minor_units = available
    state.accounts[1].ledger_minor_units = available
    goal.goal.amount.minor_units = "100000"


def move_goal(amount="50000"):
    return {
        "type": "MOVE_FUNDS",
        "amount": {"currency": "SGD", "minorUnits": amount},
        "sourceAccountId": "acc-sgd",
        "destinationAccountId": "acc-sgd-save",
    }


def add_move_destination(state):
    state.accounts[0].available_minor_units = "1000000"
    state.accounts[0].ledger_minor_units = "1000000"
    state.accounts.append(
        AccountV1.model_validate(
            {
                "id": "acc-sgd-save",
                "type": "SAVINGS",
                "currency": "SGD",
                "ledgerMinorUnits": "0",
                "availableMinorUnits": "0",
                "status": "ACTIVE",
                "capabilities": ["RECEIVE_TRANSFER"],
            }
        )
    )


def add_aapl_quote(state):
    state.assets.append(
        AssetV1(
            id="asset-aapl",
            symbol="AAPL",
            name="Apple Inc.",
            assetType="EQUITY",
            tradable=True,
            settlementCurrency="USD",
        )
    )
    state.asset_quotes.append(
        AssetQuoteV1(
            quoteId="asset-quote-aapl-usd-v1",
            assetId="asset-aapl",
            settlementCurrency="USD",
            unitPriceMinor="20000",
            feeMinor="100",
            expiresAt="2099-01-01T00:00:00Z",
        )
    )
    state.accounts[1].capabilities.append("TRADE_ASSET")


def fund_aapl_purchase(state, available="1000000"):
    state.accounts[1].available_minor_units = available
    state.accounts[1].ledger_minor_units = available


def constraint(payload):
    return (
        TypeAdapter(GroundedGoalConstraintV1)
        .validate_python(payload)
        .model_dump(mode="json", by_alias=True)
    )


def assert_success(result):
    assert hasattr(result, "financial_plan"), result.model_dump(mode="json", by_alias=True)
    return result


def rehash_plan(payload):
    semantic = deepcopy(payload)
    semantic.pop("planHash", None)
    payload["planHash"] = hashlib.sha256(
        json.dumps(semantic, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def test_one_item_direct_transfer_matches_single_goal_semantics():
    goal, state = fixture()
    direct_state(goal, state)
    single = compile_goal(goal, state)
    result = assert_success(
        compile_goal_bundle(bundle([item("deliver", goal.goal, goal.entity_bindings)]), state)
    )
    assert [step.action for step in result.financial_plan.steps] == ["TRANSFER"]
    assert result.financial_plan.steps[0].parameters == single.plan.steps[0].parameters
    assert result.satisfaction_proof.item_coverage[0].item_id == "deliver"


def test_one_item_fx_transfer_matches_single_goal_semantics():
    goal, state = fixture()
    single = compile_goal(goal, state)
    result = assert_success(
        compile_goal_bundle(bundle([item("deliver", goal.goal, goal.entity_bindings)]), state)
    )
    assert [step.action for step in result.financial_plan.steps] == [
        step.action for step in single.plan.steps
    ]
    assert [step.parameters for step in result.financial_plan.steps] == [
        step.parameters for step in single.plan.steps
    ]
    assert result.satisfaction_proof.item_coverage[0].satisfied_by_step_ids == [
        step.id for step in result.financial_plan.steps
    ]
    assert validate_bundle_plan(
        bundle([item("deliver", goal.goal, goal.entity_bindings)]),
        result.financial_plan,
        result.satisfaction_proof,
        state,
    )


def test_one_item_move_funds_matches_single_goal_semantics():
    goal, state = fixture()
    add_move_destination(state)
    contract = bundle([item("move", TypeAdapter(GroundedGoalV1).validate_python(move_goal()))])
    result = assert_success(compile_goal_bundle(contract, state))
    assert [step.action for step in result.financial_plan.steps] == ["MOVE_FUNDS"]
    assert result.financial_plan.steps[0].reversible


@pytest.mark.parametrize(
    ("asset_id", "budget", "quantity"),
    [
        ("asset-aapl", {"currency": "USD", "minorUnits": "100000"}, None),
        ("asset-msft", None, "1"),
        ("asset-other", {"currency": "USD", "minorUnits": "100000"}, "1"),
    ],
)
def test_acquire_asset_fails_closed_without_authoritative_price(asset_id, budget, quantity):
    _, state = fixture()
    state.assets.append(
        AssetV1(
            id=asset_id,
            symbol="GENERIC",
            name="Generic asset",
            assetType="EQUITY",
            tradable=True,
            settlementCurrency="USD",
        )
    )
    state.accounts[1].capabilities.append("TRADE_ASSET")
    goal = {"type": "ACQUIRE_ASSET", "assetId": asset_id}
    if budget is not None:
        goal["budget"] = budget
    if quantity is not None:
        goal["quantity"] = quantity
    parsed = TypeAdapter(GroundedGoalV1).validate_python(goal)
    result = compile_goal_bundle(bundle([item("buy", parsed)]), state)
    assert result.status == "UNSAT"
    assert result.reason.code == "ASSET_PRICE_UNAVAILABLE"


def test_headline_transfer_then_buy_binds_authoritative_quote_and_dependency():
    goal, state = fixture()
    state.accounts[1].available_minor_units = "100000"
    state.accounts[1].ledger_minor_units = "100000"
    add_aapl_quote(state)
    transfer = TypeAdapter(GroundedGoalV1).validate_python(
        {
            "type": "DELIVER_MONEY",
            "amount": {"currency": "USD", "minorUnits": "30000"},
            "recipientId": goal.goal.recipient_id,
        }
    )
    acquire = TypeAdapter(GroundedGoalV1).validate_python(
        {"type": "ACQUIRE_ASSET", "assetId": "asset-aapl", "quantity": "1"}
    )
    contract = bundle(
        [item("item-1", transfer), item("item-2", acquire)],
        dependencies=[
            {
                "beforeItemId": "item-1",
                "afterItemId": "item-2",
                "reason": "USER_EXPLICIT_ORDER",
            }
        ],
        global_constraints=[
            {
                "type": "MIN_AVAILABLE_BALANCE",
                "money": {"currency": "SGD", "minorUnits": "100000"},
            }
        ],
    )
    result = assert_success(compile_goal_bundle(contract, state))
    assert [step.action for step in result.financial_plan.steps] == ["TRANSFER", "BUY_ASSET"]
    transfer_step, buy_step = result.financial_plan.steps
    assert buy_step.depends_on == [transfer_step.id]
    assert buy_step.parameters.model_dump(mode="json", by_alias=True) == {
        "sourceAccountId": "acc-usd",
        "assetId": "asset-aapl",
        "quantity": "1",
        "maximumSpend": {"currency": "USD", "minorUnits": "20100"},
        "quoteId": "asset-quote-aapl-usd-v1",
        "settlementCurrency": "USD",
        "quotedUnitPriceMinor": "20000",
        "quotedFeeMinor": "100",
        "authorizedTotalMinor": "20100",
    }
    assert result.financial_plan.validity.required_quote_ids == ["asset-quote-aapl-usd-v1"]
    assert validate_bundle_plan(contract, result.financial_plan, result.satisfaction_proof, state)


@pytest.mark.parametrize(
    ("currency", "maximum", "expected_status", "expected_code"),
    [
        ("USD", "20100", "SAT", None),
        ("USD", "20000", "UNSAT", "MAX_TOTAL_COST_VIOLATED"),
        ("SGD", "30000", "UNSAT", "COST_CURRENCY_MISMATCH"),
    ],
)
def test_acquire_asset_enforces_exact_total_cost_including_fee(
    currency, maximum, expected_status, expected_code
):
    _, state = fixture()
    add_aapl_quote(state)
    fund_aapl_purchase(state)
    acquire = TypeAdapter(GroundedGoalV1).validate_python(
        {"type": "ACQUIRE_ASSET", "assetId": "asset-aapl", "quantity": "1"}
    )
    maximum_cost = constraint(
        {"type": "MAX_TOTAL_COST", "money": {"currency": currency, "minorUnits": maximum}}
    )
    result = compile_goal_bundle(bundle([item("buy", acquire, constraints=[maximum_cost])]), state)
    if expected_status == "SAT":
        plan = assert_success(result).financial_plan
        assert plan.steps[0].parameters.authorized_total_minor == "20100"
        assert validate_bundle_plan(
            bundle([item("buy", acquire, constraints=[maximum_cost])]),
            plan,
            result.satisfaction_proof,
            state,
        )
    else:
        assert result.status == expected_status
        assert result.reason.code == expected_code
        if expected_code == "MAX_TOTAL_COST_VIOLATED":
            assert result.reason.details["projectedMinorUnits"] == "20100"
            assert result.reason.details["maximumMinorUnits"] == "20000"


def test_acquire_asset_lock_in_constraint_fails_closed_without_authoritative_metadata():
    _, state = fixture()
    add_aapl_quote(state)
    fund_aapl_purchase(state)
    acquire = TypeAdapter(GroundedGoalV1).validate_python(
        {"type": "ACQUIRE_ASSET", "assetId": "asset-aapl", "quantity": "1"}
    )
    lock_in = constraint({"type": "MAX_LOCK_IN_DAYS", "days": 0})
    result = compile_goal_bundle(bundle([item("buy", acquire, constraints=[lock_in])]), state)
    assert result.status == "UNSAT"
    assert result.reason.code == "LOCK_IN_DURATION_UNKNOWN"
    assert result.reason.details["scope"] == "ITEM"


def test_acquire_asset_enforces_excluded_account_and_minimum_balance():
    _, state = fixture()
    add_aapl_quote(state)
    fund_aapl_purchase(state)
    acquire = TypeAdapter(GroundedGoalV1).validate_python(
        {"type": "ACQUIRE_ASSET", "assetId": "asset-aapl", "quantity": "1"}
    )
    excluded = constraint({"type": "EXCLUDED_ACCOUNT", "accountId": "acc-usd"})
    excluded_result = compile_goal_bundle(
        bundle([item("buy", acquire, constraints=[excluded])]), state
    )
    assert excluded_result.status == "UNSAT"
    assert excluded_result.reason.code == "EXCLUDED_ACCOUNT_USED"

    minimum = constraint(
        {
            "type": "MIN_AVAILABLE_BALANCE",
            "money": {"currency": "USD", "minorUnits": "990000"},
            "accountId": "acc-usd",
        }
    )
    minimum_result = compile_goal_bundle(
        bundle([item("buy", acquire, constraints=[minimum])]), state
    )
    assert minimum_result.status == "UNSAT"
    assert minimum_result.reason.code == "MIN_AVAILABLE_BALANCE_VIOLATED"


def test_acquire_unknown_asset_fails_closed():
    _, state = fixture()
    goal = {"type": "ACQUIRE_ASSET", "assetId": "missing", "quantity": "1"}
    parsed = TypeAdapter(GroundedGoalV1).validate_python(goal)
    result = compile_goal_bundle(bundle([item("buy", parsed)]), state)
    assert result.reason.code == "ASSET_NOT_FOUND"


@pytest.mark.parametrize(
    "goal",
    [
        {"type": "ACQUIRE_ASSET", "assetId": "asset-x", "quantity": "0"},
        {
            "type": "ACQUIRE_ASSET",
            "assetId": "asset-x",
            "budget": {"currency": "USD", "minorUnits": "0"},
        },
    ],
)
def test_acquire_rejects_non_positive_target_or_budget(goal):
    _, state = fixture()
    parsed = TypeAdapter(GroundedGoalV1).validate_python(goal)
    result = compile_goal_bundle(bundle([item("buy", parsed)]), state)
    assert result.status == "UNSAT"
    assert result.reason.code in {"INVALID_QUANTITY", "INVALID_AMOUNT"}


def test_acquire_untradable_asset_is_policy_blocked():
    _, state = fixture()
    state.assets.append(
        AssetV1(
            id="asset-x",
            symbol="X",
            name="X",
            assetType="OTHER",
            tradable=False,
            settlementCurrency="USD",
        )
    )
    goal = TypeAdapter(GroundedGoalV1).validate_python(
        {"type": "ACQUIRE_ASSET", "assetId": "asset-x", "quantity": "1"}
    )
    result = compile_goal_bundle(bundle([item("buy", goal)]), state)
    assert result.status == "POLICY_BLOCKED"
    assert result.reason.code == "ASSET_NOT_TRADABLE"


def test_acquire_requires_eligible_settlement_account():
    _, state = fixture()
    state.assets.append(
        AssetV1(
            id="asset-x",
            symbol="X",
            name="X",
            assetType="OTHER",
            tradable=True,
            settlementCurrency="EUR",
        )
    )
    goal = TypeAdapter(GroundedGoalV1).validate_python(
        {"type": "ACQUIRE_ASSET", "assetId": "asset-x", "quantity": "1"}
    )
    result = compile_goal_bundle(bundle([item("buy", goal)]), state)
    assert result.reason.code == "NO_ELIGIBLE_SETTLEMENT_ACCOUNT"


def test_two_independent_items_have_no_cross_item_dependency():
    goal, state = fixture()
    direct_state(goal, state)
    add_move_destination(state)
    contract = bundle(
        [
            item("deliver", goal.goal, goal.entity_bindings),
            item("move", TypeAdapter(GroundedGoalV1).validate_python(move_goal())),
        ]
    )
    result = assert_success(compile_goal_bundle(contract, state))
    assert [step.action for step in result.financial_plan.steps] == ["TRANSFER", "MOVE_FUNDS"]
    assert result.financial_plan.steps[1].depends_on == []
    assert {entry.item_id for entry in result.satisfaction_proof.item_coverage} == {
        "deliver",
        "move",
    }


def test_explicit_dependency_is_encoded_and_proven():
    goal, state = fixture()
    direct_state(goal, state)
    add_move_destination(state)
    dependency = {"beforeItemId": "move", "afterItemId": "deliver", "reason": "USER_EXPLICIT_ORDER"}
    contract = bundle(
        [
            item("deliver", goal.goal, goal.entity_bindings),
            item("move", TypeAdapter(GroundedGoalV1).validate_python(move_goal())),
        ],
        [dependency],
    )
    result = assert_success(compile_goal_bundle(contract, state))
    assert [step.action for step in result.financial_plan.steps] == ["MOVE_FUNDS", "TRANSFER"]
    assert result.financial_plan.steps[1].depends_on == [result.financial_plan.steps[0].id]
    assert validate_bundle_plan(contract, result.financial_plan, result.satisfaction_proof, state)


def test_composite_aggregate_insufficient_funds_fails_on_second_item():
    goal, state = fixture()
    direct_state(goal, state, available="150000")
    first = deepcopy(goal.goal)
    second = deepcopy(goal.goal)
    first.amount.minor_units = "100000"
    second.amount.minor_units = "100000"
    result = compile_goal_bundle(bundle([item("one", first), item("two", second)]), state)
    assert result.status == "UNSAT"
    assert result.reason.details["itemId"] == "two"


def test_global_max_total_cost_applies_to_whole_bundle():
    goal, state = fixture()
    direct_state(goal, state)
    first = deepcopy(goal.goal)
    second = deepcopy(goal.goal)
    second.amount.minor_units = "200000"
    maximum = constraint(
        {"type": "MAX_TOTAL_COST", "money": {"currency": "USD", "minorUnits": "250000"}}
    )
    result = compile_goal_bundle(
        bundle([item("one", first), item("two", second)], global_constraints=[maximum]), state
    )
    assert result.status == "UNSAT"
    assert result.reason.code == "MAX_TOTAL_COST_VIOLATED"
    assert result.reason.details["scope"] == "GLOBAL"


def test_global_minimum_balance_applies_after_all_items():
    goal, state = fixture()
    direct_state(goal, state, available="350000")
    first = deepcopy(goal.goal)
    second = deepcopy(goal.goal)
    second.amount.minor_units = "200000"
    minimum = constraint(
        {
            "type": "MIN_AVAILABLE_BALANCE",
            "money": {"currency": "USD", "minorUnits": "100000"},
            "accountId": "acc-usd",
        }
    )
    result = compile_goal_bundle(
        bundle([item("one", first), item("two", second)], global_constraints=[minimum]), state
    )
    assert result.status == "UNSAT"
    assert result.reason.code == "MIN_AVAILABLE_BALANCE_VIOLATED"


def test_unsupported_item_blocks_whole_bundle():
    goal, state = fixture()
    direct_state(goal, state)
    bill = TypeAdapter(GroundedGoalV1).validate_python({"type": "PAY_BILL", "billerId": "biller-1"})
    result = compile_goal_bundle(bundle([item("deliver", goal.goal), item("bill", bill)]), state)
    assert result.status == "UNSAT"
    assert result.reason.code == "UNSUPPORTED_GOAL"
    assert result.reason.details["itemId"] == "bill"


def test_false_proof_flag_cannot_make_plan_ready():
    goal, state = fixture()
    direct_state(goal, state)
    contract = bundle([item("deliver", goal.goal)])
    result = assert_success(compile_goal_bundle(contract, state))
    payload = result.satisfaction_proof.model_dump(mode="json", by_alias=True)
    payload["allItemsSatisfied"] = False
    proof = BundleSatisfactionProofV1.model_validate(payload)
    assert not validate_bundle_plan(contract, result.financial_plan, proof, state)


def test_missing_item_coverage_is_rejected():
    goal, state = fixture()
    direct_state(goal, state)
    contract = bundle([item("deliver", goal.goal)])
    result = assert_success(compile_goal_bundle(contract, state))
    payload = result.satisfaction_proof.model_dump(mode="json", by_alias=True)
    payload["itemCoverage"] = []
    assert not validate_bundle_plan(
        contract, result.financial_plan, BundleSatisfactionProofV1.model_validate(payload), state
    )


def test_unrelated_irreversible_transfer_is_rejected():
    goal, state = fixture()
    direct_state(goal, state)
    contract = bundle([item("deliver", goal.goal)])
    result = assert_success(compile_goal_bundle(contract, state))
    payload = result.financial_plan.model_dump(mode="json", by_alias=True)
    injected = deepcopy(payload["steps"][0])
    injected["id"] = "injected"
    injected["sequence"] = 1
    injected["parameters"]["amount"]["minorUnits"] = "1"
    payload["steps"].append(injected)
    rehash_plan(payload)
    plan = FinancialPlanV1.model_validate(payload)
    assert not validate_bundle_plan(contract, plan, result.satisfaction_proof, state)


def test_unrelated_buy_asset_is_rejected():
    goal, state = fixture()
    direct_state(goal, state)
    contract = bundle([item("deliver", goal.goal)])
    result = assert_success(compile_goal_bundle(contract, state))
    payload = result.financial_plan.model_dump(mode="json", by_alias=True, exclude_none=True)
    payload["steps"].append(
        {
            "id": "injected-buy",
            "sequence": 1,
            "dependsOn": [],
            "reversible": False,
            "action": "BUY_ASSET",
            "parameters": {
                "sourceAccountId": "acc-usd",
                "assetId": "unrelated-asset",
                "quantity": "1",
                "maximumSpend": {"currency": "USD", "minorUnits": "1"},
                "quoteId": "unrelated-quote",
                "settlementCurrency": "USD",
                "quotedUnitPriceMinor": "1",
                "quotedFeeMinor": "0",
                "authorizedTotalMinor": "1",
            },
        }
    )
    rehash_plan(payload)
    plan = FinancialPlanV1.model_validate(payload)
    assert not validate_bundle_plan(contract, plan, result.satisfaction_proof, state)


def test_every_irreversible_step_in_generated_plan_is_justified():
    goal, state = fixture()
    contract = bundle([item("deliver", goal.goal)])
    result = assert_success(compile_goal_bundle(contract, state))
    assert all(not step.reversible for step in result.financial_plan.steps)
    assert result.satisfaction_proof.all_irreversible_steps_justified
    assert validate_bundle_plan(contract, result.financial_plan, result.satisfaction_proof, state)


def test_policy_blocked_item_prevents_composite_ready():
    goal, state = fixture()
    direct_state(goal, state)
    state.assets.append(
        AssetV1(
            id="asset-blocked",
            symbol="BLOCKED",
            name="Blocked asset",
            assetType="OTHER",
            tradable=False,
            settlementCurrency="USD",
        )
    )
    acquire = TypeAdapter(GroundedGoalV1).validate_python(
        {"type": "ACQUIRE_ASSET", "assetId": "asset-blocked", "quantity": "1"}
    )
    result = compile_goal_bundle(
        bundle([item("deliver", goal.goal), item("acquire", acquire)]), state
    )
    assert result.status == "POLICY_BLOCKED"
    assert result.reason.details["itemId"] == "acquire"


def test_required_fx_is_accepted_as_justified():
    goal, state = fixture()
    contract = bundle([item("deliver", goal.goal)])
    result = assert_success(compile_goal_bundle(contract, state))
    assert [step.action for step in result.financial_plan.steps] == ["FX_CONVERT", "TRANSFER"]
    assert validate_bundle_plan(contract, result.financial_plan, result.satisfaction_proof, state)


def test_bundle_compilation_is_deterministic():
    goal, state = fixture()
    contract = bundle([item("deliver", goal.goal)])
    assert compile_goal_bundle(contract, state) == compile_goal_bundle(contract, state)


def test_item_reordering_changes_plan_identity():
    goal, state = fixture()
    direct_state(goal, state)
    add_move_destination(state)
    deliver = item("deliver", goal.goal)
    move = item("move", TypeAdapter(GroundedGoalV1).validate_python(move_goal()))
    left = assert_success(compile_goal_bundle(bundle([deliver, move]), state))
    right = assert_success(compile_goal_bundle(bundle([move, deliver]), state))
    assert left.financial_plan.id != right.financial_plan.id
    assert left.financial_plan.plan_hash != right.financial_plan.plan_hash


def test_dependency_mutation_changes_plan_identity():
    goal, state = fixture()
    direct_state(goal, state)
    add_move_destination(state)
    items = [
        item("deliver", goal.goal),
        item("move", TypeAdapter(GroundedGoalV1).validate_python(move_goal())),
    ]
    left = assert_success(compile_goal_bundle(bundle(items), state))
    dependency = {"beforeItemId": "move", "afterItemId": "deliver", "reason": "USER_EXPLICIT_ORDER"}
    right = assert_success(compile_goal_bundle(bundle(items, [dependency]), state))
    assert left.financial_plan.plan_hash != right.financial_plan.plan_hash


def test_http_bundle_endpoint_and_single_endpoint_both_exist():
    goal, state = fixture()
    direct_state(goal, state)
    contract = bundle([item("deliver", goal.goal)])
    client = TestClient(app)
    response = client.post(
        "/v1/compile-bundle",
        json={
            "goalBundle": contract.model_dump(mode="json", by_alias=True),
            "bankState": state.model_dump(mode="json", by_alias=True),
        },
    )
    assert response.status_code == 200
    assert response.json()["satisfactionProof"]["allItemsSatisfied"] is True
    single = client.post(
        "/v1/compile",
        json={
            "goalContract": goal.model_dump(mode="json", by_alias=True),
            "bankStateSnapshot": state.model_dump(mode="json", by_alias=True),
        },
    )
    assert single.status_code == 200
    assert single.json()["status"] == "SAT"


def test_python_bundle_model_rejects_cycle_defensively():
    goal, _ = fixture()
    with pytest.raises(ValidationError):
        bundle(
            [item("one", goal.goal), item("two", goal.goal)],
            [
                {"beforeItemId": "one", "afterItemId": "two", "reason": "USER_EXPLICIT_ORDER"},
                {"beforeItemId": "two", "afterItemId": "one", "reason": "USER_EXPLICIT_ORDER"},
            ],
        )
