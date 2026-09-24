from copy import deepcopy
from decimal import Decimal
from pathlib import Path

from app.constraints.cost import account_costs_for_limit
from app.constraints.evaluator import evaluate_constraints
from app.models.contracts import (
    AccountV1,
    BankStateSnapshotV1,
    GoalContractV1,
    MaxTotalCostGroundedV1,
)
from app.operations.library import operation_sort_key
from app.operations.models import FxConvert, Money, MoveFunds, Transfer
from app.simulator.apply import apply_operation
from app.simulator.state import SimulatedState, canonical_state_digest

FIXTURES = Path(__file__).resolve().parents[3] / "packages/contracts/fixtures"


def snapshot():
    return BankStateSnapshotV1.model_validate_json(
        (FIXTURES / "01-ntu-transfer/bank-state.json").read_text()
    )


def goal(maximum):
    result = GoalContractV1.model_validate_json(
        (FIXTURES / "01-ntu-transfer/goal-contract.json").read_text()
    )
    result.constraints = [
        MaxTotalCostGroundedV1(
            type="MAX_TOTAL_COST", money={"currency": "SGD", "minorUnits": str(maximum)}
        )
    ]
    return result


def route():
    return (
        FxConvert("acc-sgd", "acc-usd", Money("SGD", 666667), "USD", "quote-sgd-usd-1"),
        Transfer("acc-usd", "ben-ntu", Money("USD", 500000)),
    )


def test_fx_funding_is_counted_once_at_exact_boundary():
    state = snapshot()
    operations = route()
    after_fx = apply_operation(state, operations[0])
    assert after_fx.success
    after_transfer = apply_operation(after_fx.state, operations[1])
    assert after_transfer.success
    assert after_transfer.state.to_snapshot().accounts[1].available_minor_units == "0"
    costs = account_costs_for_limit(state, operations, "SGD")
    assert costs.total("SGD") == 666767  # 666667 funding + 100 SGD quote fee
    assert costs.foreign_currencies("SGD") == ()
    assert [entry.component for entry in costs.entries] == ["FEE", "ATTRIBUTED_FUNDING"]
    assert evaluate_constraints(goal(666767), state, state, operations).valid
    above = evaluate_constraints(goal(666766), state, state, operations)
    assert [item.code for item in above.violations] == ["MAX_TOTAL_COST_VIOLATED"]
    assert above.violations[0].details["projectedMinorUnits"] == "666767"
    assert account_costs_for_limit(state, operations, "SGD") == costs
    assert evaluate_constraints(goal(666767), state, state, operations).valid


def test_unrelated_foreign_fee_fails_closed():
    state = snapshot()
    state.accounts.append(
        AccountV1(
            id="acc-usd-2",
            type="WALLET",
            currency="USD",
            ledgerMinorUnits="0",
            availableMinorUnits="0",
            status="ACTIVE",
            capabilities=["RECEIVE_TRANSFER"],
        )
    )
    operations = (
        route()[0],
        MoveFunds("acc-usd", "acc-usd-2", Money("USD", 100), Money("USD", 5)),
    )
    result = evaluate_constraints(goal(700000), state, state, operations)
    assert [item.code for item in result.violations] == ["COST_CURRENCY_MISMATCH"]
    assert result.violations[0].details["costCurrency"] == "USD"


def test_unrelated_foreign_spending_and_mixed_destination_fail_closed():
    state = snapshot()
    state.accounts[1].available_minor_units = "1"
    state.accounts[1].ledger_minor_units = "1"
    result = evaluate_constraints(goal(700000), state, state, route())
    assert [item.code for item in result.violations] == ["COST_CURRENCY_MISMATCH"]


def test_expired_candidate_quote_cannot_prove_funding():
    state = snapshot()
    state.fx_quotes[0].expires_at = state.captured_at
    result = evaluate_constraints(goal(700000), state, state, route())
    assert [item.code for item in result.violations] == [
        "COST_UNAVAILABLE",
        "COST_CURRENCY_MISMATCH",
    ]


def test_canonical_simulated_state_digest():
    state = snapshot()
    reordered = deepcopy(state)
    reordered.accounts.reverse()
    reordered.accounts[0].capabilities.reverse()
    first = SimulatedState.from_snapshot(state)
    second = SimulatedState.from_snapshot(reordered)
    assert first.snapshot_json != second.snapshot_json
    assert first.digest() == second.digest() == canonical_state_digest(state)
    changed = apply_operation(state, route()[0]).state
    assert changed is not None
    assert changed.digest() != first.digest()
    assert changed.digest() == canonical_state_digest(changed.to_snapshot())
    assert first.advanced(state).digest() == first.digest()


def test_operation_sort_key_is_stable_and_normalizes_decimal():
    operations = [
        Transfer("acc-usd", "ben-ntu", Money("USD", 5)),
        route()[0],
        Transfer("acc-sgd", "ben-ntu", Money("SGD", 10)),
        Transfer("acc-sgd", "ben-ntu", Money("SGD", 2)),
    ]
    first = sorted(operations, key=operation_sort_key)
    assert first == sorted(reversed(operations), key=operation_sort_key)
    assert [item.action for item in first] == ["TRANSFER", "TRANSFER", "TRANSFER", "FX_CONVERT"]
    from app.operations.models import BuyAsset

    assert operation_sort_key(
        BuyAsset("acc-usd", "asset-a", Decimal("1.0"), Money("USD", 100))
    ) == operation_sort_key(BuyAsset("acc-usd", "asset-a", Decimal("1.00"), Money("USD", 100)))
