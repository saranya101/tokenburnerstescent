"""C1 feasibility probes only: no production alternative generator or consent bypass."""

from test_arjun_bundle_safety import headline, refuse, success

from app.planner.bundle import _item_goal_contract, compile_goal_bundle
from app.relaxation import find_max_feasible_amount


def test_existing_maximum_amount_helper_preserves_reserve_for_single_goal():
    contract, state = headline(sgd=136000)
    goal = _item_goal_contract(contract.items[0], state)
    goal.constraints = contract.global_constraints
    result = find_max_feasible_amount(goal, state, upper_bound=136000)
    assert result.status == "FEASIBLE"
    assert result.maximum_feasible_amount.minor_units == "36000"
    assert goal.goal.amount.minor_units == "10000"
    assert goal.constraints[0].money.minor_units == "100000"


def test_reduced_transfer_candidate_recompiles_preserving_all_hard_constraints():
    original, state = headline(sgd=136000)
    refuse(original, state, "MIN_AVAILABLE_BALANCE_VIOLATED")
    # Exact synthetic arithmetic: 136000 - 100000 reserve - (26800 FX + 25 fee).
    # Candidate is separate meaning. Production would require fresh confirmation/hash.
    proposed = original.model_copy(deep=True)
    proposed.bundle_id = "proposed-reduced-transfer"
    proposed.bundle_version += 1
    proposed.items[0].goal.amount.minor_units = "9175"
    plan = success(proposed, state).financial_plan
    assert proposed.global_constraints == original.global_constraints
    assert proposed.items[1] == original.items[1]
    assert plan.projected_outcome.projected_available_balances[0].money.minor_units == "100000"
    proposed.items[0].goal.amount.minor_units = "9176"
    refuse(proposed, state, "MIN_AVAILABLE_BALANCE_VIOLATED")
    assert original.items[0].goal.amount.minor_units == "10000"
    refuse(original, state, "MIN_AVAILABLE_BALANCE_VIOLATED")


def test_omitted_goal_is_a_separate_proposal_and_original_remains_unsat():
    original, state = headline(sgd=136000)
    for remaining in original.items:
        proposed = original.model_copy(deep=True)
        proposed.bundle_id = "proposed-" + remaining.item_id
        proposed.items = [remaining]
        proposed.explicit_dependencies = []
        success(proposed, state)
    refuse(original, state, "MIN_AVAILABLE_BALANCE_VIOLATED")


def test_no_positive_whole_share_or_transfer_alternative_above_reserve():
    original, state = headline(sgd=100000)
    for remaining in original.items:
        proposed = original.model_copy(deep=True)
        proposed.items = [remaining]
        proposed.explicit_dependencies = []
        assert compile_goal_bundle(proposed, state).status == "UNSAT"
    # Zero quantity is not a viable purchase.
    proposed = original.model_copy(deep=True)
    proposed.items = [proposed.items[1]]
    proposed.explicit_dependencies = []
    proposed.items[0].goal.quantity = "0"
    refuse(proposed, state, "INVALID_QUANTITY")


def test_candidate_exclusions_and_stale_quotes_remain_binding():
    original, state = headline(sgd=136000)
    proposed = original.model_copy(deep=True)
    proposed.items[0].goal.amount.minor_units = "9175"
    success(proposed, state)
    state.asset_quotes[0].expires_at = state.captured_at
    refuse(proposed, state, "ASSET_PRICE_UNAVAILABLE")
    state = headline(sgd=136000)[1]
    proposed.items[1].constraints = [
        original.global_constraints[0].model_validate(
            {
                "type": "MIN_AVAILABLE_BALANCE",
                "accountId": "sgd-source",
                "money": {"currency": "SGD", "minorUnits": "100000"},
            }
        )
    ]
    # Account exclusions are tested on the production bundle path, too.
    from pydantic import TypeAdapter

    from app.models.contracts import GroundedGoalConstraintV1

    proposed.items[1].constraints.append(
        TypeAdapter(GroundedGoalConstraintV1).validate_python(
            {"type": "EXCLUDED_ACCOUNT", "accountId": "sgd-source"}
        )
    )
    refuse(proposed, state, "EXCLUDED_ACCOUNT_USED")
