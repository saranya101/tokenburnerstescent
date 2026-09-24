"""Regression checks for defects surfaced by the C7 evaluation corpus."""

from test_planner_c3a import account, fixture

from app.planner.compiler import compile_goal


def test_fully_funded_frozen_source_is_policy_blocked():
    goal, state = fixture()
    state.accounts.clear()
    account(state, "funded-frozen", "USD", 600000, ["SEND_TRANSFER"], "FROZEN")
    result = compile_goal(goal, state)
    assert result.status == "POLICY_BLOCKED"
    assert result.reason.code == "ACCOUNT_FROZEN"
    assert result.reason.details["accountId"] == "funded-frozen"


def test_malformed_snapshot_balance_fails_closed():
    goal, state = fixture()
    state.accounts[0].available_minor_units = "invalid"
    result = compile_goal(goal, state)
    assert result.status == "UNSAT"
    assert result.reason.code == "INVALID_STATE_AMOUNT"


def test_malformed_goal_amount_fails_closed():
    goal, state = fixture()
    goal.goal.amount.minor_units = "invalid"
    result = compile_goal(goal, state)
    assert result.status == "UNSAT"
    assert result.reason.code == "INVALID_AMOUNT"
