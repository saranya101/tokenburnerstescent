from copy import deepcopy
from decimal import Decimal
from pathlib import Path

import pytest

from app.models.contracts import BankStateSnapshotV1, ObligationV1
from app.operations.library import OPERATION_LIBRARY, OPERATION_VIOLATIONS
from app.operations.models import (
    BuyAsset,
    FxConvert,
    Money,
    MoveFunds,
    PayBill,
    SellAsset,
    Transfer,
)
from app.simulator.apply import apply_operation

FIXTURES = Path(__file__).resolve().parents[3] / "packages/contracts/fixtures"


def snapshot(folder="01-ntu-transfer"):
    return BankStateSnapshotV1.model_validate_json(
        (FIXTURES / folder / "bank-state.json").read_text()
    )


def codes(result):
    return {item.code for item in result.violations}


def account(state, account_id):
    return next(item for item in state.to_snapshot().accounts if item.id == account_id)


def test_library_has_concrete_definitions():
    assert len(OPERATION_LIBRARY) == 6
    assert OPERATION_VIOLATIONS.keys() == OPERATION_LIBRARY.keys()
    assert all(OPERATION_VIOLATIONS.values())
    assert all("TODO" not in str(value.model_dump()) for value in OPERATION_LIBRARY.values())
    assert OPERATION_LIBRARY["MOVE_FUNDS"].reversible
    assert all(
        not item.reversible for key, item in OPERATION_LIBRARY.items() if key != "MOVE_FUNDS"
    )


def test_transfer_valid_immutable_deterministic():
    original = snapshot()
    operation = Transfer("acc-usd", "ben-ntu", Money("USD", 100))
    # Fund the source account in the fixture before simulating.
    original.accounts[1].available_minor_units = "1000"
    original.accounts[1].ledger_minor_units = "1000"
    before = deepcopy(original.model_dump(mode="json"))
    first = apply_operation(original, operation)
    second = apply_operation(original, operation)
    assert first == second
    assert first.success and first.state.source_state_version == 7
    assert first.state.applied_operations == 1
    assert original.model_dump(mode="json") == before
    assert account(first.state, "acc-usd").available_minor_units == "900"
    assert account(first.state, "acc-usd").ledger_minor_units == "900"
    assert first.state.to_snapshot().state_version == 7
    assert first.state.to_snapshot().captured_at == original.captured_at
    assert first.reversible is False


@pytest.mark.parametrize(
    ("change", "expected"),
    [
        (lambda s: s.accounts.pop(1), "ACCOUNT_NOT_FOUND"),
        (lambda s: setattr(s.accounts[1], "status", "FROZEN"), "ACCOUNT_INACTIVE"),
        (
            lambda s: s.accounts[1].capabilities.remove("SEND_TRANSFER"),
            "UNSUPPORTED_ACCOUNT_CAPABILITY",
        ),
        (lambda s: s.beneficiaries.clear(), "BENEFICIARY_NOT_FOUND"),
        (
            lambda s: setattr(s.beneficiaries[0], "status", "PENDING_VERIFICATION"),
            "BENEFICIARY_NOT_VERIFIED",
        ),
        (lambda s: setattr(s.service_availability, "transfers", False), "SERVICE_UNAVAILABLE"),
        (lambda s: setattr(s.accounts[1], "available_minor_units", "1"), "INSUFFICIENT_FUNDS"),
    ],
)
def test_transfer_failures(change, expected):
    state = snapshot()
    state.accounts[1].available_minor_units = "1000"
    state.accounts[1].ledger_minor_units = "1000"
    change(state)
    result = apply_operation(state, Transfer("acc-usd", "ben-ntu", Money("USD", 100)))
    assert expected in codes(result)
    assert result.state is None
    assert result.violations[0].details


def test_transfer_amount_and_fee():
    state = snapshot()
    state.accounts[1].available_minor_units = "1000"
    state.accounts[1].ledger_minor_units = "1000"
    result = apply_operation(
        state, Transfer("acc-usd", "ben-ntu", Money("USD", 100), Money("USD", 5))
    )
    assert account(result.state, "acc-usd").available_minor_units == "895"
    assert result.fee == Money("USD", 5)
    assert "INVALID_AMOUNT" in codes(
        apply_operation(state, Transfer("acc-usd", "ben-ntu", Money("USD", 0)))
    )


def test_move_funds_effects_and_failures():
    state = snapshot("05-balance-changed")
    move = MoveFunds("acc-checking", "acc-savings", Money("SGD", 10000))
    result = apply_operation(state, move)
    assert result.success and result.reversible
    assert account(result.state, "acc-checking").available_minor_units == "15000"
    assert account(result.state, "acc-checking").ledger_minor_units == "65000"
    assert account(result.state, "acc-savings").available_minor_units == "110000"
    assert "INSUFFICIENT_FUNDS" in codes(
        apply_operation(state, MoveFunds("acc-checking", "acc-savings", Money("SGD", 30000)))
    )
    assert "CURRENCY_MISMATCH" in codes(
        apply_operation(state, MoveFunds("acc-checking", "acc-savings", Money("USD", 100)))
    )
    state.accounts[1].capabilities.clear()
    assert "UNSUPPORTED_ACCOUNT_CAPABILITY" in codes(apply_operation(state, move))


def test_fx_conversion_fee_decimal_and_rounding():
    state = snapshot()
    operation = FxConvert("acc-sgd", "acc-usd", Money("SGD", 101), "USD", "quote-sgd-usd-1")
    result = apply_operation(state, operation)
    assert result.success
    assert account(result.state, "acc-sgd").available_minor_units == "999799"
    assert account(result.state, "acc-usd").available_minor_units == "76"  # 101 * .75 = 75.75
    assert result.fee == Money("SGD", 100)
    state.fx_quotes[0].rate = "0.5"
    state.fx_quotes[0].fee = None
    even = apply_operation(
        state, FxConvert("acc-sgd", "acc-usd", Money("SGD", 5), "USD", "quote-sgd-usd-1")
    )
    assert account(even.state, "acc-usd").available_minor_units == "2"  # 2.5 half-even


@pytest.mark.parametrize(
    ("change", "expected"),
    [
        (lambda s: setattr(s.service_availability, "fx", False), "SERVICE_UNAVAILABLE"),
        (lambda s: s.fx_quotes.clear(), "QUOTE_NOT_FOUND"),
        (lambda s: setattr(s.fx_quotes[0], "expires_at", s.captured_at), "QUOTE_EXPIRED"),
        (lambda s: setattr(s.fx_quotes[0], "to_currency", "EUR"), "CURRENCY_MISMATCH"),
        (lambda s: setattr(s.accounts[0], "available_minor_units", "1"), "INSUFFICIENT_FUNDS"),
    ],
)
def test_fx_failures(change, expected):
    state = snapshot()
    change(state)
    result = apply_operation(
        state, FxConvert("acc-sgd", "acc-usd", Money("SGD", 100), "USD", "quote-sgd-usd-1")
    )
    assert expected in codes(result)


def test_pay_bill_effect_and_failures():
    state = snapshot("05-balance-changed")
    state.accounts[0].capabilities.append("PAY_BILL")
    state.obligations = [
        ObligationV1.model_validate(
            {
                "id": "bill-1",
                "description": "Utilities",
                "money": {"currency": "SGD", "minorUnits": "10000"},
                "dueAt": "2026-09-25T00:00:00Z",
                "status": "OPEN",
            }
        )
    ]
    operation = PayBill("acc-checking", "bill-1", Money("SGD", 10000))
    result = apply_operation(state, operation)
    assert result.success
    assert account(result.state, "acc-checking").available_minor_units == "15000"
    assert result.state.to_snapshot().obligations[0].status == "PAID"
    assert result.state.to_snapshot().obligations[0].money.minor_units == "0"
    state.service_availability.bill_payments = False
    assert "SERVICE_UNAVAILABLE" in codes(apply_operation(state, operation))
    state.service_availability.bill_payments = True
    assert "INSUFFICIENT_FUNDS" in codes(
        apply_operation(state, PayBill("acc-checking", "bill-1", Money("SGD", 30000)))
    )


def test_buy_asset_effect_and_failures():
    state = snapshot("02-apple-investment")
    operation = BuyAsset(
        "acc-brokerage",
        "asset-aapl",
        Decimal("1.25"),
        Money("USD", 12000),
        Money("USD", 50),
        Money("USD", 13000),
    )
    result = apply_operation(state, operation)
    assert result.success
    assert account(result.state, "acc-brokerage").available_minor_units == "487950"
    assert result.state.to_snapshot().holdings[0].quantity == "3.5"
    state.service_availability.investments = False
    assert "SERVICE_UNAVAILABLE" in codes(apply_operation(state, operation))
    state.service_availability.investments = True
    state.assets[0].tradable = False
    assert "ASSET_NOT_TRADABLE" in codes(apply_operation(state, operation))
    state.assets[0].tradable = True
    state.accounts[0].available_minor_units = "100"
    assert "INSUFFICIENT_FUNDS" in codes(apply_operation(state, operation))
    assert "MAXIMUM_SPEND_EXCEEDED" in codes(
        apply_operation(
            state,
            BuyAsset(
                "acc-brokerage",
                "asset-aapl",
                Decimal("1"),
                Money("USD", 100),
                maximum_spend=Money("USD", 99),
            ),
        )
    )


def test_sell_asset_effect_and_failures():
    state = snapshot("02-apple-investment")
    operation = SellAsset(
        "acc-brokerage", "asset-aapl", Decimal("1.25"), Money("USD", 15000), Money("USD", 20)
    )
    result = apply_operation(state, operation)
    assert result.success
    assert account(result.state, "acc-brokerage").available_minor_units == "514980"
    assert result.state.to_snapshot().holdings[0].quantity == "1"
    assert "INSUFFICIENT_HOLDING" in codes(
        apply_operation(
            state, SellAsset("acc-brokerage", "asset-aapl", Decimal("3"), Money("USD", 15000))
        )
    )
    state.assets.clear()
    assert "ASSET_NOT_FOUND" in codes(apply_operation(state, operation))
    state = snapshot("02-apple-investment")
    state.assets[0].tradable = False
    assert "ASSET_NOT_TRADABLE" in codes(apply_operation(state, operation))
