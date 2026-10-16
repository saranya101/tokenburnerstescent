"""Funding and reserve regressions for the hosted conversational demo."""

import pytest
from test_planner_c3a import constraint, fixture

from app.planner.compiler import compile_goal


@pytest.mark.parametrize(
    ("amount", "reserve", "reason"),
    [
        ("2000001", None, "INSUFFICIENT_FUNDS"),
        ("1950000", "100000", "MIN_AVAILABLE_BALANCE_VIOLATED"),
    ],
)
def test_john_transfer_declines_unavailable_funds_and_preserves_reserve(amount, reserve, reason):
    goal, state = fixture()
    goal.goal.amount.currency = "SGD"
    goal.goal.amount.minor_units = amount
    goal.goal.recipient_id = "ben-john-lim"
    payee = state.beneficiaries[0].model_copy(deep=True)
    payee.id = "ben-john-lim"
    payee.name = "John Lim"
    payee.supported_currencies = ["SGD"]
    state.beneficiaries = [payee]
    for account in state.accounts:
        balance = "2000000" if account.currency == "SGD" else "0"
        account.available_minor_units = balance
        account.ledger_minor_units = balance
    if reserve is not None:
        constraint(
            goal,
            {
                "type": "MIN_AVAILABLE_BALANCE",
                "money": {"currency": "SGD", "minorUnits": reserve},
            },
        )
    before = state.model_dump(mode="json", by_alias=True)
    result = compile_goal(goal, state)
    assert result.status == "UNSAT"
    assert result.reason.code == reason
    assert state.model_dump(mode="json", by_alias=True) == before
