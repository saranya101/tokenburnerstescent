"""Whole-plan replay, goal preservation, and changed-state classification."""

import hashlib
import json
from copy import deepcopy
from datetime import timedelta

from test_planner_c3a import account, constraint, fixture, hard

from app.planner.compiler import compile_goal
from app.preflight import (
    ExecutionProgress,
    _operation,
    check_step_goal_preservation,
    preflight_plan,
)
from app.revalidation import revalidate_plan
from app.simulator.apply import apply_operation


def fx_case():
    goal, state = fixture()
    plan = compile_goal(goal, state).plan
    assert [step.action for step in plan.steps] == ["FX_CONVERT", "TRANSFER"]
    return goal, state, plan


def direct_case():
    goal, state = fixture()
    state.accounts[0].available_minor_units = "0"
    state.accounts[0].ledger_minor_units = "0"
    state.accounts[1].available_minor_units = "600000"
    state.accounts[1].ledger_minor_units = "600000"
    plan = compile_goal(goal, state).plan
    assert len(plan.steps) == 1
    return goal, state, plan


def resign(plan):
    payload = plan.model_dump(mode="json", by_alias=True, exclude_none=True)
    payload.pop("planHash")
    plan.plan_hash = hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    ).hexdigest()


def test_whole_plan_ready_and_input_immutable():
    goal, state, plan = fx_case()
    before = deepcopy(state.model_dump(mode="json", by_alias=True))
    result = preflight_plan(goal, plan, state)
    assert result.status == "READY"
    assert result.steps_simulated == 2
    assert state.model_dump(mode="json", by_alias=True) == before


def test_tampered_parameters_wrong_goal_version_and_projection():
    goal, state, plan = fx_case()
    tampered = deepcopy(plan)
    tampered.steps[1].parameters.amount.minor_units = "1"
    assert preflight_plan(goal, tampered, state).status == "INVALID_PLAN"
    wrong_goal = deepcopy(goal)
    wrong_goal.version += 1
    assert preflight_plan(wrong_goal, plan, state).reason.code == "GOAL_BINDING_MISMATCH"
    bad_projection = deepcopy(plan)
    bad_projection.projected_outcome.projected_available_balances[0].money.minor_units = "0"
    resign(bad_projection)
    result = preflight_plan(goal, bad_projection, state)
    assert result.status == "INVALID_PLAN"
    assert result.reason.code == "PROJECTED_BALANCE_MISMATCH"


def test_expired_quote_hard_rule_and_beneficiary_policy():
    goal, state, plan = fx_case()
    expired = deepcopy(state)
    expired.captured_at = expired.fx_quotes[0].expires_at
    assert preflight_plan(goal, plan, expired).reason.code == "QUOTE_EXPIRED"
    excluded = hard("EXCLUDED_ACCOUNT", accountId="acc-sgd")
    result = preflight_plan(goal, plan, state, (excluded,))
    assert result.status == "GOAL_NO_LONGER_SATISFIABLE"
    blocked = deepcopy(state)
    blocked.beneficiaries[0].status = "BLOCKED"
    assert preflight_plan(goal, plan, blocked).status == "POLICY_BLOCKED"


def test_quote_economics_change_with_same_id_fails_closed():
    goal, state, plan = fx_case()
    changed = deepcopy(state)
    changed.fx_quotes[0].rate = "0.750000001"
    result = preflight_plan(goal, plan, changed)
    assert result.status == "STATE_CHANGED"
    assert result.reason.code == "FX_BINDING_UNPROVEN"
    assert check_step_goal_preservation(goal, plan, 0, changed).status == "STALE_PLAN"


def test_next_fx_step_preserves_goal_when_transfer_remains_possible():
    goal, state, plan = fx_case()
    result = check_step_goal_preservation(goal, plan, 0, state)
    assert result.status == "PRESERVED"
    assert result.compiler_calls == 1
    assert result.resulting_state is not None


def test_valid_fx_is_blocked_when_later_transfer_service_disappears():
    goal, state, plan = fx_case()
    changed = deepcopy(state)
    changed.state_version += 1
    changed.service_availability.transfers = False
    result = check_step_goal_preservation(goal, plan, 0, changed)
    assert result.status == "WOULD_BREAK_GOAL"
    assert result.reason.code == "REQUIRED_SERVICE_UNAVAILABLE"
    assert result.compiler_calls == 1


def test_valid_fx_is_blocked_when_beneficiary_becomes_blocked():
    goal, state, plan = fx_case()
    changed = deepcopy(state)
    changed.state_version += 1
    changed.beneficiaries[0].status = "BLOCKED"
    result = check_step_goal_preservation(goal, plan, 0, changed)
    assert result.status == "WOULD_BREAK_GOAL"
    assert result.reason.code == "BENEFICIARY_BLOCKED"


def test_invalid_next_step_and_excluded_funding():
    goal, state, plan = fx_case()
    changed = deepcopy(state)
    changed.accounts[0].available_minor_units = "0"
    changed.accounts[0].ledger_minor_units = "0"
    assert check_step_goal_preservation(goal, plan, 0, changed).status == "INVALID_NEXT_STEP"
    rule = hard("EXCLUDED_ACCOUNT", accountId="acc-sgd")
    result = check_step_goal_preservation(goal, plan, 0, state, (rule,))
    assert result.status == "WOULD_BREAK_GOAL"


def test_step_that_requires_a_different_remaining_route_requests_replan():
    goal, state = fixture()
    goal.goal.amount.currency = "SGD"
    goal.goal.amount.minor_units = "500000"
    state.accounts.clear()
    account(state, "source", "SGD", 300000, ["SEND_TRANSFER"])
    account(state, "destination", "SGD", 250000, ["SEND_TRANSFER", "RECEIVE_TRANSFER"])
    account(state, "alternative", "SGD", 0, ["SEND_TRANSFER"])
    plan = compile_goal(goal, state).plan
    assert [step.action for step in plan.steps] == ["MOVE_FUNDS", "TRANSFER"]
    changed = deepcopy(state)
    changed.state_version += 1
    changed.accounts[1].capabilities.remove("SEND_TRANSFER")
    changed.accounts[2].available_minor_units = "500000"
    changed.accounts[2].ledger_minor_units = "500000"
    result = check_step_goal_preservation(goal, plan, 0, changed)
    assert result.status == "REPLAN_REQUIRED"
    assert result.reason.code == "REMAINING_ROUTE_CHANGED"


def test_same_state_and_irrelevant_version_change_remain_valid():
    goal, state, plan = direct_case()
    assert revalidate_plan(goal, plan, state).status == "PLAN_STILL_VALID"
    changed = deepcopy(state)
    changed.state_version += 1
    changed.accounts[0].available_minor_units = "123"
    changed.accounts[0].ledger_minor_units = "123"
    result = revalidate_plan(goal, plan, changed)
    assert result.status == "PLAN_STILL_VALID"
    assert result.state_version_changed


def test_balance_drop_with_alternative_requires_replan_and_differences():
    goal, state, plan = direct_case()
    account(state, "alternative-usd", "USD", 0, ["SEND_TRANSFER"])
    # Recompile the approved plan against the original, now expanded, snapshot.
    plan = compile_goal(goal, state).plan
    changed = deepcopy(state)
    changed.state_version += 1
    changed.accounts[1].available_minor_units = "0"
    changed.accounts[1].ledger_minor_units = "0"
    changed.accounts[2].available_minor_units = "600000"
    changed.accounts[2].ledger_minor_units = "600000"
    result = revalidate_plan(goal, plan, changed)
    assert result.status == "REPLAN_REQUIRED"
    assert result.replans_available == 1
    assert result.compiler_calls == 1
    assert any(item.field == "sourceAccount" for item in result.differences)


def test_balance_drop_without_alternative_is_unsat():
    goal, state, plan = direct_case()
    changed = deepcopy(state)
    changed.state_version += 1
    changed.accounts[1].available_minor_units = "0"
    changed.accounts[1].ledger_minor_units = "0"
    result = revalidate_plan(goal, plan, changed)
    assert result.status == "GOAL_NOW_UNSAT"
    assert result.reason is not None


def test_expired_quote_with_and_without_replacement():
    goal, state, plan = fx_case()
    expired = deepcopy(state)
    expired.state_version += 1
    expired.captured_at = expired.fx_quotes[0].expires_at
    replacement = deepcopy(expired.fx_quotes[0])
    replacement.id = "replacement-quote"
    replacement.expires_at += timedelta(minutes=5)
    expired.fx_quotes.append(replacement)
    result = revalidate_plan(goal, plan, expired)
    assert result.status == "REPLAN_REQUIRED"
    assert any(item.field == "quoteIds" for item in result.differences)
    expired.fx_quotes.pop()
    result = revalidate_plan(goal, plan, expired)
    assert result.status == "GOAL_NOW_UNSAT"


def test_transfer_service_and_beneficiary_policy_revalidation():
    goal, state, plan = fx_case()
    changed = deepcopy(state)
    changed.state_version += 1
    changed.service_availability.transfers = False
    assert revalidate_plan(goal, plan, changed).status == "POLICY_BLOCKED"
    changed.service_availability.transfers = True
    changed.beneficiaries[0].status = "BLOCKED"
    assert revalidate_plan(goal, plan, changed).status == "POLICY_BLOCKED"


def test_partial_execution_uses_real_state_and_requires_valid_prefix():
    goal, state, plan = fx_case()
    fx = plan.steps[0]
    transition = apply_operation(state, _operation(fx))
    assert transition.success
    current = transition.state.to_snapshot()
    current.state_version += 1
    progress = ExecutionProgress((fx.id,))
    result = preflight_plan(goal, plan, current, progress=progress)
    assert result.status == "READY"
    assert result.steps_simulated == 1
    assert (
        check_step_goal_preservation(goal, plan, 1, current, progress=progress).status
        == "PRESERVED"
    )
    assert revalidate_plan(goal, plan, current, progress=progress).status == "PLAN_STILL_VALID"
    wrong = ExecutionProgress((plan.steps[1].id,))
    assert preflight_plan(goal, plan, current, progress=wrong).status == "INVALID_PROGRESS"
    assert (
        check_step_goal_preservation(goal, plan, 1, current, progress=wrong).status
        == "INVALID_PROGRESS"
    )
    unknown = ExecutionProgress((), (fx.id,))
    assert preflight_plan(goal, plan, current, progress=unknown).status == "INVALID_PROGRESS"


def test_repeated_c4_classification_and_snapshot_immutability():
    goal, state, plan = fx_case()
    original = state.model_dump(mode="json", by_alias=True)
    assert all(
        preflight_plan(goal, plan, state) == preflight_plan(goal, plan, state) for _ in range(5)
    )
    assert all(
        check_step_goal_preservation(goal, plan, 0, state)
        == check_step_goal_preservation(goal, plan, 0, state)
        for _ in range(5)
    )
    assert all(
        revalidate_plan(goal, plan, state) == revalidate_plan(goal, plan, state) for _ in range(5)
    )
    assert state.model_dump(mode="json", by_alias=True) == original


def test_partial_cost_provenance_fails_closed():
    goal, state, plan = fx_case()
    constraint(
        goal, {"type": "MAX_TOTAL_COST", "money": {"currency": "SGD", "minorUnits": "700000"}}
    )
    plan = compile_goal(goal, state).plan
    transition = apply_operation(state, _operation(plan.steps[0]))
    current = transition.state.to_snapshot()
    progress = ExecutionProgress((plan.steps[0].id,))
    result = preflight_plan(goal, plan, current, progress=progress)
    assert result.status == "CANNOT_PROVE_SAFE"
