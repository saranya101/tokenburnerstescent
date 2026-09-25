from copy import deepcopy
from decimal import Decimal
from pathlib import Path

import pytest
from pydantic import TypeAdapter

from app.constraints.cost import account_costs
from app.constraints.effective_rules import merge_effective_rules
from app.constraints.evaluator import CandidateOperation, evaluate_constraints
from app.constraints.liquidity import available_liquidity
from app.constraints.z3_solver import ConstraintSolver, NumericCheck
from app.models.contracts import (
    BankStateSnapshotV1,
    GoalContractV1,
    GroundedGoalConstraintV1,
    HardRule,
)
from app.operations.models import BuyAsset, FxConvert, Money, MoveFunds, SellAsset, Transfer
from app.policy.engine import PolicyEngine
from app.simulator.apply import apply_operation

FIXTURES = Path(__file__).resolve().parents[3] / "packages/contracts/fixtures"


def fixture(folder, name, model):
    return model.model_validate_json((FIXTURES / folder / name).read_text())


def goal(*constraints):
    value = fixture("01-ntu-transfer", "goal-contract.json", GoalContractV1)
    value.constraints = [
        TypeAdapter(GroundedGoalConstraintV1).validate_python(item) for item in constraints
    ]
    return value


def snapshot(folder="01-ntu-transfer"):
    return fixture(folder, "bank-state.json", BankStateSnapshotV1)


def hard(kind, **fields):
    return TypeAdapter(HardRule).validate_python(
        {
            "schemaVersion": "1",
            "id": "hard-1",
            "userId": "user-1",
            "type": kind,
            "enabled": True,
            **fields,
        }
    )


def minimum(amount, account_id=None):
    item = {
        "type": "MIN_AVAILABLE_BALANCE",
        "money": {"currency": "SGD", "minorUnits": str(amount)},
    }
    if account_id is not None:
        item["accountId"] = account_id
    return item


def maximum(amount):
    return {"type": "MAX_TOTAL_COST", "money": {"currency": "SGD", "minorUnits": str(amount)}}


def codes(result):
    return [item.code for item in result.violations]


@pytest.mark.parametrize(("amount", "valid"), [(999999, True), (1000000, True), (1000001, False)])
def test_minimum_balance_boundaries(amount, valid):
    result = evaluate_constraints(goal(minimum(amount)), snapshot(), snapshot())
    assert result.valid is valid
    assert codes(result) == ([] if valid else ["MIN_AVAILABLE_BALANCE_VIOLATED"])


def test_specific_account_and_multiple_accounts():
    state = snapshot("05-balance-changed")
    assert available_liquidity(state, "SGD") == 125000
    assert available_liquidity(state, "SGD", "acc-checking") == 25000
    assert evaluate_constraints(goal(minimum(125000)), state, state).valid
    assert not evaluate_constraints(goal(minimum(25001, "acc-checking")), state, state).valid
    state.accounts[1].status = "FROZEN"
    assert available_liquidity(state, "SGD") == 25000


def test_persistent_minimum_wins_with_provenance_and_no_mutation():
    contract = goal(minimum(200000))
    prior = deepcopy(contract.model_dump(mode="json"))
    rule = hard("MIN_AVAILABLE_BALANCE", money={"currency": "SGD", "minorUnits": "1200000"})
    result = evaluate_constraints(contract, snapshot(), snapshot(), hard_rules=(rule,))
    assert codes(result) == ["MIN_AVAILABLE_BALANCE_VIOLATED"]
    assert result.violations[0].source == "PERSISTENT_USER_RULE"
    assert {origin.source for origin in result.violations[0].origins} == {
        "REQUEST",
        "PERSISTENT_USER_RULE",
    }
    assert result.violations[0].details["requiredMinorUnits"] == "1200000"
    assert contract.model_dump(mode="json") == prior
    assert result.effective_rules.rules[0].minor_units == 1200000


@pytest.mark.parametrize(("limit", "valid"), [(101, True), (100, True), (99, False)])
def test_maximum_cost_boundaries(limit, valid):
    operation = Transfer("acc-sgd", "ben-ntu", Money("SGD", 100))
    result = evaluate_constraints(goal(maximum(limit)), snapshot(), snapshot(), (operation,))
    assert result.valid is valid
    assert codes(result) == ([] if valid else ["MAX_TOTAL_COST_VIOLATED"])


def test_cost_accounting_counts_fx_fee_and_not_internal_principal():
    state = snapshot()
    operations = (
        FxConvert("acc-sgd", "acc-usd", Money("SGD", 500000), "USD", "quote-sgd-usd-1"),
        MoveFunds("acc-sgd", "acc-usd", Money("SGD", 1000)),
    )
    costs = account_costs(state, operations)
    assert costs.total("SGD") == 100
    assert not evaluate_constraints(goal(maximum(99)), state, state, operations).valid
    assert evaluate_constraints(goal(maximum(100)), state, state, operations).valid


def test_cost_large_integer_and_foreign_currency_fail_closed():
    state = snapshot()
    large = 10**40 + 1
    operation = Transfer("acc-sgd", "ben-ntu", Money("SGD", large))
    assert codes(evaluate_constraints(goal(maximum(10**40)), state, state, (operation,))) == [
        "MAX_TOTAL_COST_VIOLATED"
    ]
    foreign = Transfer("acc-usd", "ben-ntu", Money("USD", 1))
    assert codes(evaluate_constraints(goal(maximum(100)), state, state, (foreign,))) == [
        "COST_CURRENCY_MISMATCH"
    ]
    assert isinstance(account_costs(state, (operation,)).total("SGD"), int)
    negative_fee = Transfer("acc-sgd", "ben-ntu", Money("SGD", 100), Money("SGD", -1))
    assert codes(evaluate_constraints(goal(maximum(100)), state, state, (negative_fee,))) == [
        "COST_INPUT_INVALID"
    ]


def test_excluded_account_request_persistent_and_union():
    state = snapshot()
    normal = Transfer("acc-sgd", "ben-ntu", Money("SGD", 100))
    excluded = {"type": "EXCLUDED_ACCOUNT", "accountId": "acc-sgd"}
    assert evaluate_constraints(
        goal(excluded), state, state, (Transfer("acc-usd", "ben-ntu", Money("USD", 1)),)
    ).valid
    assert codes(evaluate_constraints(goal(excluded), state, state, (normal,))) == [
        "EXCLUDED_ACCOUNT_USED"
    ]
    persistent = hard("EXCLUDED_ACCOUNT", accountId="acc-sgd")
    assert codes(evaluate_constraints(goal(), state, state, (normal,), (persistent,))) == [
        "EXCLUDED_ACCOUNT_USED"
    ]
    persistent2 = hard("EXCLUDED_ACCOUNT", accountId="acc-usd")
    merged = merge_effective_rules(goal(excluded), (persistent2,))
    assert {rule.account_id for rule in merged.rules} == {"acc-sgd", "acc-usd"}


def test_multiple_constraints_order_and_immutability_determinism():
    contract = goal(
        maximum(1), minimum(1000001), {"type": "EXCLUDED_ACCOUNT", "accountId": "acc-sgd"}
    )
    state = snapshot()
    before = deepcopy(state.model_dump(mode="json"))
    operation = Transfer("acc-sgd", "ben-ntu", Money("SGD", 100))
    first = evaluate_constraints(contract, state, state, (operation,))
    second = evaluate_constraints(contract, state, state, (operation,))
    assert first == second
    assert codes(first) == [
        "MAX_TOTAL_COST_VIOLATED",
        "MIN_AVAILABLE_BALANCE_VIOLATED",
        "EXCLUDED_ACCOUNT_USED",
    ]
    assert state.model_dump(mode="json") == before
    assert evaluate_constraints(
        goal(maximum(100), minimum(1000000)), state, state, (operation,)
    ).valid
    assert codes(
        evaluate_constraints(goal(maximum(100), minimum(1000001)), state, state, (operation,))
    ) == ["MIN_AVAILABLE_BALANCE_VIOLATED"]


def test_projected_simulated_state_is_used():
    state = snapshot()
    simulated = apply_operation(state, Transfer("acc-sgd", "ben-ntu", Money("SGD", 100))).state
    assert codes(evaluate_constraints(goal(minimum(1000000)), state, simulated)) == [
        "MIN_AVAILABLE_BALANCE_VIOLATED"
    ]


def test_lock_in_metadata_and_unknown_buy_duration():
    state = snapshot("02-apple-investment")
    buy = BuyAsset("acc-brokerage", "asset-aapl", Decimal("1"), Money("USD", 100))
    contract = goal({"type": "MAX_LOCK_IN_DAYS", "days": 30})
    assert codes(evaluate_constraints(contract, state, state, (buy,))) == [
        "LOCK_IN_DURATION_UNKNOWN"
    ]
    assert evaluate_constraints(contract, state, state, (CandidateOperation(buy, 30),)).valid
    assert codes(evaluate_constraints(contract, state, state, (CandidateOperation(buy, 31),))) == [
        "MAX_LOCK_IN_DAYS_VIOLATED"
    ]


def test_persistent_max_single_transaction_and_disabled_rules():
    state = snapshot()
    operation = Transfer("acc-sgd", "ben-ntu", Money("SGD", 101))
    rule = hard("MAX_SINGLE_TRANSACTION", money={"currency": "SGD", "minorUnits": "100"})
    assert codes(evaluate_constraints(goal(), state, state, (operation,), (rule,))) == [
        "MAX_SINGLE_TRANSACTION_VIOLATED"
    ]
    foreign = Transfer("acc-usd", "ben-ntu", Money("USD", 1))
    assert codes(evaluate_constraints(goal(), state, state, (foreign,), (rule,))) == [
        "TRANSACTION_CURRENCY_MISMATCH"
    ]
    rule.enabled = False
    assert evaluate_constraints(goal(), state, state, (operation,), (rule,)).valid


def test_foreign_user_rule_fails_closed():
    state = snapshot()
    rule = hard("EXCLUDED_ACCOUNT", accountId="acc-sgd")
    rule.user_id = "other"
    assert codes(evaluate_constraints(goal(), state, state, hard_rules=(rule,))) == [
        "HARD_RULE_USER_MISMATCH"
    ]


def test_policy_allowed_and_allowlist():
    state = snapshot()
    operation = Transfer("acc-sgd", "ben-ntu", Money("SGD", 100))
    assert PolicyEngine().evaluate(state, operation).allowed
    assert [
        item.code for item in PolicyEngine(frozenset()).evaluate(state, operation).violations
    ] == ["OPERATION_NOT_ALLOWED"]


@pytest.mark.parametrize(
    ("change", "expected"),
    [
        (lambda s: setattr(s.accounts[0], "status", "FROZEN"), "ACCOUNT_FROZEN"),
        (lambda s: setattr(s.accounts[0], "status", "CLOSED"), "ACCOUNT_INACTIVE"),
        (lambda s: setattr(s.beneficiaries[0], "status", "BLOCKED"), "BENEFICIARY_BLOCKED"),
        (
            lambda s: setattr(s.beneficiaries[0], "status", "PENDING_VERIFICATION"),
            "BENEFICIARY_UNVERIFIED",
        ),
        (lambda s: setattr(s.service_availability, "transfers", False), "SERVICE_UNAVAILABLE"),
        (
            lambda s: s.accounts[0].capabilities.remove("SEND_TRANSFER"),
            "ACCOUNT_CAPABILITY_MISSING",
        ),
    ],
)
def test_policy_blocks(change, expected):
    state = snapshot()
    change(state)
    result = PolicyEngine().evaluate(state, Transfer("acc-sgd", "ben-ntu", Money("SGD", 100)))
    assert expected in [item.code for item in result.violations]
    assert all(item.source == "BANK_POLICY" and item.details for item in result.violations)


def test_policy_nontradable_asset_and_simulated_state():
    state = snapshot("02-apple-investment")
    state.assets[0].tradable = False
    operation = SellAsset("acc-brokerage", "asset-aapl", Decimal("1"), Money("USD", 100))
    assert [item.code for item in PolicyEngine().evaluate(state, operation).violations] == [
        "ASSET_NOT_TRADABLE"
    ]


def test_z3_numeric_sat_unsat():
    solver = ConstraintSolver()
    assert solver.check_minimum_balance(100, 40, 60)
    assert not solver.check_minimum_balance(100, 41, 60)
    assert solver.check_maximum_cost(6900, 6900)
    assert not solver.check_maximum_cost(6934, 6900)
    assert solver.solve_numeric_constraints(
        (NumericCheck("MINIMUM", 100, 100), NumericCheck("MAXIMUM", 100, 100))
    )
