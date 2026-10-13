"""Fixed, in-memory DBS bundle evidence; no database or banking calls."""

import hashlib
import json
import subprocess
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError
from test_bundle_compiler import rehash_plan

from app.main import app
from app.models.contracts import BankStateSnapshotV1, FinancialPlanV1, GoalBundleContractV1
from app.planner.bundle import _operation_from_step, compile_goal_bundle, validate_bundle_plan
from app.simulator.apply import apply_operation
from app.simulator.state import SimulatedState

ROOT = Path(__file__).resolve().parents[3]


def headline(sgd=200000, usd=0, authorize_fx=True, reserve=100000):
    """Confirmed meaning: send SGD100 to John, then buy exactly one AAPL."""
    state = BankStateSnapshotV1.model_validate(
        {
            "schemaVersion": "1",
            "userId": "synthetic-arjun",
            "stateVersion": 42,
            "capturedAt": "2026-10-12T00:00:00Z",
            "accounts": [
                {
                    "id": "sgd-source",
                    "type": "SAVINGS",
                    "currency": "SGD",
                    "ledgerMinorUnits": str(sgd),
                    "availableMinorUnits": str(sgd),
                    "status": "ACTIVE",
                    "capabilities": ["SEND_TRANSFER", "CONVERT_FX", "RECEIVE_TRANSFER"],
                },
                {
                    "id": "usd-invest",
                    "type": "BROKERAGE",
                    "currency": "USD",
                    "ledgerMinorUnits": str(usd),
                    "availableMinorUnits": str(usd),
                    "status": "ACTIVE",
                    "capabilities": ["TRADE_ASSET", "RECEIVE_TRANSFER"],
                },
            ],
            "beneficiaries": [
                {
                    "id": "john-lim",
                    "name": "John Lim",
                    "supportedCurrencies": ["SGD"],
                    "status": "ACTIVE",
                }
            ],
            "assets": [
                {
                    "id": "aapl",
                    "symbol": "AAPL",
                    "name": "Apple Inc.",
                    "assetType": "EQUITY",
                    "tradable": True,
                    "settlementCurrency": "USD",
                }
            ],
            "holdings": [],
            "obligations": [],
            "serviceAvailability": {
                "transfers": True,
                "fx": True,
                "billPayments": True,
                "investments": True,
            },
            "fxQuotes": [
                {
                    "id": "fx-fixed",
                    "fromCurrency": "SGD",
                    "toCurrency": "USD",
                    "rate": "0.75",
                    "fee": {"currency": "SGD", "minorUnits": "25"},
                    "expiresAt": "2026-10-12T00:10:00Z",
                }
            ],
            "assetQuotes": [
                {
                    "quoteId": "aapl-fixed",
                    "assetId": "aapl",
                    "settlementCurrency": "USD",
                    "unitPriceMinor": "20000",
                    "feeMinor": "100",
                    "expiresAt": "2026-10-12T00:05:00Z",
                }
            ],
        }
    )
    contract = GoalBundleContractV1.model_validate(
        {
            "schemaVersion": "1",
            "bundleId": "synthetic-transfer-then-aapl",
            "bundleVersion": 1,
            "items": [
                {
                    "itemId": "send",
                    "goal": {
                        "type": "DELIVER_MONEY",
                        "amount": {"currency": "SGD", "minorUnits": "10000"},
                        "recipientId": "john-lim",
                    },
                    "constraints": [],
                    "preferences": [],
                    "bindings": [],
                },
                {
                    "itemId": "buy",
                    "goal": {"type": "ACQUIRE_ASSET", "assetId": "aapl", "quantity": "1"},
                    "constraints": [],
                    "preferences": (
                        [{"type": "PREFER_ACCOUNT", "accountId": "sgd-source"}]
                        if authorize_fx
                        else []
                    ),
                    "bindings": [],
                },
            ],
            "globalConstraints": [
                {
                    "type": "MIN_AVAILABLE_BALANCE",
                    "accountId": "sgd-source",
                    "money": {"currency": "SGD", "minorUnits": str(reserve)},
                }
            ],
            "explicitDependencies": [
                {"beforeItemId": "send", "afterItemId": "buy", "reason": "USER_EXPLICIT_ORDER"}
            ],
            "contractHash": "a" * 64,
        }
    )
    from app.models.contracts import EntityBinding

    for item, reference, entity_type, entity_id in (
        (contract.items[0], "John Lim", "BENEFICIARY", "john-lim"),
        (contract.items[1], "Apple (AAPL)", "ASSET", "aapl"),
        (contract.items[1], "my SGD account", "ACCOUNT", "sgd-source"),
    ):
        item.bindings.append(
            EntityBinding(
                schemaVersion="1",
                reference=reference,
                entityType=entity_type,
                entityId=entity_id,
                resolutionMethod="USER_CONFIRMED",
                confirmed=True,
            )
        )
    semantic = contract.model_dump(mode="json", by_alias=True, exclude_none=True)
    semantic.pop("contractHash")
    contract.contract_hash = hashlib.sha256(
        json.dumps(semantic, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    return contract, state


def success(contract, state):
    result = compile_goal_bundle(contract, state)
    assert hasattr(result, "financial_plan"), result.model_dump(by_alias=True)
    assert validate_bundle_plan(contract, result.financial_plan, result.satisfaction_proof, state)
    return result


def balances(snapshot):
    return {account.id: account.available_minor_units for account in snapshot.accounts}


def refuse(contract, state, code, status="UNSAT"):
    original = state.model_dump_json()
    result = compile_goal_bundle(contract, state)
    assert result.status == status
    assert result.reason.code == code
    assert not hasattr(result, "financial_plan")
    assert state.model_dump_json() == original
    return result


def test_a1_sgd_funding_exact_quotes_dependencies_balances_holdings_and_no_mutation():
    contract, state = headline()
    original = state.model_dump_json()
    result = success(contract, state)
    plan = result.financial_plan
    assert [step.action for step in plan.steps] == ["TRANSFER", "FX_CONVERT", "BUY_ASSET"]
    send, fx, buy = plan.steps
    assert send.depends_on == []
    assert fx.depends_on == [send.id]
    assert buy.depends_on == [fx.id]
    assert send.parameters.amount.minor_units == "10000"
    assert send.parameters.beneficiary_id == "john-lim"
    assert fx.parameters.source_money.minor_units == "26800"
    assert fx.parameters.source_account_id == "sgd-source"
    assert buy.parameters.source_account_id == "usd-invest"
    assert buy.parameters.quantity == "1"
    assert buy.parameters.quoted_unit_price_minor == "20000"
    assert buy.parameters.quoted_fee_minor == "100"
    assert buy.parameters.authorized_total_minor == "20100"
    assert plan.bank_state_version == 42
    assert plan.validity.required_quote_ids == ["aapl-fixed", "fx-fixed"]
    assert plan.validity.valid_until == state.asset_quotes[0].expires_at
    assert {
        b.account_id: b.money.minor_units
        for b in plan.projected_outcome.projected_available_balances
    } == {"sgd-source": "163175", "usd-invest": "0"}
    assert [(a.asset_id, a.quantity) for a in plan.projected_outcome.acquired_assets] == [
        ("aapl", "1")
    ]
    assert state.model_dump_json() == original


def test_a2_existing_usd_avoids_fx_and_accounts_reconcile():
    contract, state = headline(usd=20101)
    plan = success(contract, state).financial_plan
    assert [step.action for step in plan.steps] == ["TRANSFER", "BUY_ASSET"]
    assert plan.steps[1].depends_on == [plan.steps[0].id]
    assert {
        b.account_id: b.money.minor_units
        for b in plan.projected_outcome.projected_available_balances
    } == {"sgd-source": "190000", "usd-invest": "1"}
    assert plan.validity.required_quote_ids == ["aapl-fixed"]


def test_a3_no_fx_permission_and_no_funding_account_substitution():
    contract, state = headline(authorize_fx=False)
    refuse(contract, state, "INSUFFICIENT_FUNDS")
    contract.items[1].preferences = headline()[0].items[1].preferences
    contract.items[1].preferences[0].account_id = "missing-account"
    refuse(contract, state, "INSUFFICIENT_FUNDS")


@pytest.mark.parametrize(
    "sgd,code", [(36824, "INSUFFICIENT_FUNDING_FUNDS"), (136824, "MIN_AVAILABLE_BALANCE_VIOLATED")]
)
def test_a4_b1_total_funding_and_protected_balance(sgd, code):
    contract, state = headline(sgd=sgd, reserve=0 if sgd == 36824 else 100000)
    result = refuse(contract, state, code)
    if code == "MIN_AVAILABLE_BALANCE_VIOLATED":
        assert result.reason.details == {
            "scope": "GLOBAL",
            "currency": "SGD",
            "accountId": "sgd-source",
            "requiredMinorUnits": "100000",
            "projectedMinorUnits": "99999",
        }


def test_a5_reverse_confirmed_order_changes_usd_shortfall_after_usd_transfer():
    contract, state = headline(usd=25000)
    state.accounts[1].capabilities.append("SEND_TRANSFER")
    state.beneficiaries[0].supported_currencies.append("USD")
    contract.items[0].goal.amount.currency = "USD"
    forward = success(contract, state).financial_plan
    assert [step.action for step in forward.steps] == ["TRANSFER", "FX_CONVERT", "BUY_ASSET"]
    assert forward.steps[1].parameters.source_money.minor_units == "6800"
    dependency = contract.explicit_dependencies[0]
    dependency.before_item_id, dependency.after_item_id = "buy", "send"
    # Buying first leaves only USD49; the transfer now needs FX instead.
    reverse = success(contract, state).financial_plan
    assert [step.action for step in reverse.steps] == ["BUY_ASSET", "FX_CONVERT", "TRANSFER"]
    assert reverse.steps[1].parameters.source_money.minor_units == "6800"
    assert reverse.steps[1].depends_on == [reverse.steps[0].id]


def test_a6_identical_fixed_snapshot_recompiles_identically():
    contract, state = headline()
    first = success(contract, state)
    assert all(compile_goal_bundle(contract, state) == first for _ in range(10))


@pytest.mark.parametrize(
    "role,field",
    [
        (0, "available_minor_units"),
        (0, "ledger_minor_units"),
        (1, "available_minor_units"),
        (1, "ledger_minor_units"),
    ],
)
def test_b2_only_available_and_settled_funding_counts(role, field):
    contract, state = headline(sgd=10000, usd=20100, authorize_fx=False, reserve=0)
    setattr(state.accounts[role], field, "9999" if role == 0 else "20099")
    refuse(contract, state, "INSUFFICIENT_FUNDS")


@pytest.mark.parametrize("expired", [False, True])
def test_b3_b4_unavailable_or_expired_asset_quote(expired):
    contract, state = headline()
    if expired:
        state.asset_quotes[0].expires_at = state.captured_at
    else:
        state.asset_quotes.clear()
    refuse(contract, state, "ASSET_PRICE_UNAVAILABLE")


@pytest.mark.parametrize("expired", [False, True])
def test_b5_unavailable_or_expired_fx_quote(expired):
    contract, state = headline()
    if expired:
        state.fx_quotes[0].expires_at = state.captured_at
    else:
        state.fx_quotes.clear()
    refuse(contract, state, "QUOTE_EXPIRED" if expired else "NO_FX_ROUTE")


@pytest.mark.parametrize(
    "case,code,status",
    [
        ("missing", "ASSET_NOT_FOUND", "UNSAT"),
        ("disabled", "ASSET_NOT_TRADABLE", "POLICY_BLOCKED"),
        ("service", "REQUIRED_SERVICE_UNAVAILABLE", "POLICY_BLOCKED"),
    ],
)
def test_b6_asset_and_service_eligibility(case, code, status):
    contract, state = headline()
    if case == "missing":
        state.assets.clear()
    elif case == "disabled":
        state.assets[0].tradable = False
    else:
        state.service_availability.investments = False
    refuse(contract, state, code, status)


@pytest.mark.parametrize(
    "case,code,status",
    [
        ("unknown", "BENEFICIARY_NOT_ALLOWED", "UNSAT"),
        ("blocked", "BENEFICIARY_BLOCKED", "POLICY_BLOCKED"),
        ("pending", "BENEFICIARY_UNVERIFIED", "POLICY_BLOCKED"),
        ("currency", "NO_TRANSFER_ROUTE", "UNSAT"),
    ],
)
def test_b7_beneficiary_is_authoritative(case, code, status):
    contract, state = headline()
    if case == "unknown":
        contract.items[0].goal.recipient_id = "foreign-or-unknown"
    elif case == "blocked":
        state.beneficiaries[0].status = "BLOCKED"
    elif case == "pending":
        state.beneficiaries[0].status = "PENDING_VERIFICATION"
    else:
        state.beneficiaries[0].supported_currencies = ["EUR"]
    refuse(contract, state, code, status)


@pytest.mark.parametrize("case", ["currency", "frozen", "capability"])
def test_b8_purchase_requires_eligible_settlement_account(case):
    contract, state = headline()
    if case == "currency":
        state.accounts[1].currency = "EUR"
    elif case == "frozen":
        state.accounts[1].status = "FROZEN"
    else:
        state.accounts[1].capabilities.remove("TRADE_ASSET")
    refuse(contract, state, "NO_ELIGIBLE_SETTLEMENT_ACCOUNT")


def test_b9_individually_feasible_transfer_and_purchase_cannot_double_spend():
    contract, state = headline(sgd=30000, reserve=0)
    for item in contract.items:
        solo = contract.model_copy(deep=True)
        solo.items = [item]
        solo.explicit_dependencies = []
        success(solo, state)
    refuse(contract, state, "INSUFFICIENT_FUNDING_FUNDS")


def test_b10_item_reserve_applies_at_its_completion_global_reserve_at_bundle_completion():
    contract, state = headline(sgd=136824)
    reserve = contract.global_constraints.pop()
    contract.items[0].constraints.append(reserve)
    # Transfer leaves SGD1268.24; the later independent item is outside private scope.
    success(contract, state)
    contract.items[1].constraints.append(reserve)
    refuse(contract, state, "MIN_AVAILABLE_BALANCE_VIOLATED")


@pytest.mark.parametrize(
    "dependencies",
    [
        [("missing", "buy")],
        [("send", "send")],
        [("send", "buy"), ("buy", "send")],
        [("send", "buy"), ("send", "buy")],
    ],
)
def test_b11_invalid_bundle_dependency_rejected_at_http_boundary(dependencies):
    contract, state = headline()
    payload = contract.model_dump(mode="json", by_alias=True)
    payload["explicitDependencies"] = [
        {"beforeItemId": before, "afterItemId": after, "reason": "USER_EXPLICIT_ORDER"}
        for before, after in dependencies
    ]
    with pytest.raises(ValidationError):
        GoalBundleContractV1.model_validate(payload)
    response = TestClient(app).post(
        "/v1/compile-bundle",
        json={"goalBundle": payload, "bankState": state.model_dump(mode="json", by_alias=True)},
    )
    assert response.status_code == 422


@pytest.mark.parametrize(
    "mutation",
    [
        "missing",
        "forward",
        "cycle",
        "no-fx-dependency",
        "balance",
        "holding",
        "expiry",
        "quote",
        "version",
        "quantity",
    ],
)
def test_b11_b13_validator_rejects_rehashed_material_or_dependency_mutation(mutation):
    contract, state = headline()
    result = success(contract, state)
    payload = result.financial_plan.model_dump(mode="json", by_alias=True, exclude_none=True)
    send, fx, buy = payload["steps"]
    if mutation == "missing":
        buy["dependsOn"] = ["missing"]
    elif mutation == "forward":
        send["dependsOn"] = [buy["id"]]
    elif mutation == "cycle":
        fx["dependsOn"].append(buy["id"])
    elif mutation == "no-fx-dependency":
        buy["dependsOn"] = [send["id"]]
    elif mutation == "balance":
        payload["projectedOutcome"]["projectedAvailableBalances"][0]["money"]["minorUnits"] = (
            "999999"
        )
    elif mutation == "holding":
        payload["projectedOutcome"]["acquiredAssets"][0]["quantity"] = "2"
    elif mutation == "expiry":
        payload["validity"]["validUntil"] = "2026-10-12T00:10:00Z"
    elif mutation == "quote":
        payload["validity"]["requiredQuoteIds"] = ["aapl-fixed"]
    elif mutation == "version":
        payload["bankStateVersion"] += 1
    else:
        buy["parameters"]["quantity"] = "2"
    rehash_plan(payload)
    assert not validate_bundle_plan(
        contract, FinancialPlanV1.model_validate(payload), result.satisfaction_proof, state
    )


@pytest.mark.parametrize("sgd,accepted", [(136824, False), (136825, True), (136826, True)])
def test_b12_one_cent_reserve_boundary(sgd, accepted):
    contract, state = headline(sgd=sgd)
    if accepted:
        plan = success(contract, state).financial_plan
        assert plan.projected_outcome.projected_available_balances[0].money.minor_units == str(
            sgd - 36825
        )
    else:
        refuse(contract, state, "MIN_AVAILABLE_BALANCE_VIOLATED")


@pytest.mark.parametrize(
    "quantity,unit_price,expected",
    [("0.5", "20000", "10100"), ("0.333", "20000", "6760"), ("0.333", "20001", None)],
)
def test_b12_decimal_quantity_must_have_exact_minor_unit_cost(quantity, unit_price, expected):
    # This tests arithmetic permitted by the contract, not fractional product eligibility.
    contract, state = headline(usd=20100)
    contract.items[1].goal.quantity = quantity
    state.asset_quotes[0].unit_price_minor = unit_price
    if expected:
        assert (
            success(contract, state).financial_plan.steps[-1].parameters.authorized_total_minor
            == expected
        )
    else:
        refuse(contract, state, "ASSET_QUOTE_NOT_MINOR_UNIT_EXACT")


def test_b12_half_even_fx_uses_smallest_source_amount_and_separate_fee():
    contract, state = headline(usd=20099)
    plan = success(contract, state).financial_plan
    # One SGD cent * 0.75 rounds to one USD cent. Fee is SGD25 cents separately.
    assert plan.steps[1].parameters.source_money.minor_units == "1"
    assert plan.projected_outcome.projected_available_balances[0].money.minor_units == "189974"
    state.fx_quotes[0].rate = "0.5"
    plan = success(contract, state).financial_plan
    # 1 * .5 rounds to 0 (even); 2 * .5 = 1.
    assert plan.steps[1].parameters.source_money.minor_units == "2"


@pytest.mark.parametrize("field,value", [("quantity", "-1"), ("quantity", "1e0")])
def test_b12_invalid_quantity_precision_contract_rejected(field, value):
    contract, _ = headline()
    payload = contract.model_dump(mode="json", by_alias=True)
    payload["items"][1]["goal"][field] = value
    with pytest.raises(ValidationError):
        GoalBundleContractV1.model_validate(payload)


def test_b12_non_positive_transfer_fails_without_plan():
    contract, state = headline()
    contract.items[0].goal.amount.minor_units = "-1"
    refuse(contract, state, "INVALID_AMOUNT")


def test_b13_changed_snapshot_or_quote_cannot_validate_old_plan():
    contract, state = headline()
    result = success(contract, state)
    for change in ("version", "rate", "price", "expired"):
        altered = state.model_copy(deep=True)
        if change == "version":
            altered.state_version += 1
        elif change == "rate":
            altered.fx_quotes[0].rate = "0.5"
        elif change == "price":
            altered.asset_quotes[0].unit_price_minor = "20001"
        else:
            altered.captured_at = altered.asset_quotes[0].expires_at
        assert not validate_bundle_plan(
            contract, result.financial_plan, result.satisfaction_proof, altered
        )


def test_partial_completion_prefixes_preserve_real_effects_without_rollback():
    contract, state = headline()
    result = success(contract, state)
    simulated = SimulatedState.from_snapshot(state)
    expected = [
        ({"sgd-source": "190000", "usd-invest": "0"}, []),
        ({"sgd-source": "163175", "usd-invest": "20100"}, []),
        ({"sgd-source": "163175", "usd-invest": "0"}, [("aapl", "1")]),
    ]
    for step, (expected_balances, expected_holdings) in zip(
        result.financial_plan.steps, expected, strict=True
    ):
        applied = apply_operation(simulated, _operation_from_step(step))
        assert applied.success
        simulated = applied.state
        snapshot = simulated.to_snapshot()
        assert balances(snapshot) == expected_balances
        assert [(h.asset_id, h.quantity) for h in snapshot.holdings] == expected_holdings
    assert all(not step.reversible for step in result.financial_plan.steps)


def test_b14_actual_http_results_parse_with_typescript_contracts(tmp_path):
    client = TestClient(app)
    cases = []
    for options in ({}, {"usd": 20100}, {"sgd": 136824}, {"authorize_fx": False}):
        contract, state = headline(**options)
        request = {
            "goalBundle": contract.model_dump(mode="json", by_alias=True, exclude_none=True),
            "bankState": state.model_dump(mode="json", by_alias=True, exclude_none=True),
        }
        response = client.post("/v1/compile-bundle", json=request)
        assert response.status_code == 200
        cases.append({"request": request, "response": response.json()})
    # Also exercise omitted optional deliveredMoney on the existing single HTTP endpoint.
    contract, state = headline(usd=20100)
    from app.planner.bundle import _item_goal_contract

    single = client.post(
        "/v1/compile",
        json={
            "goalContract": _item_goal_contract(contract.items[1], state).model_dump(
                mode="json", by_alias=True, exclude_none=True
            ),
            "bankStateSnapshot": state.model_dump(mode="json", by_alias=True, exclude_none=True),
        },
    )
    assert single.status_code == 200
    assert "deliveredMoney" not in single.json()["plan"]["projectedOutcome"]
    transfer_contract, transfer_state = headline()
    transfer_state.fx_quotes = []
    transfer_state.asset_quotes = []
    transfer_single = client.post(
        "/v1/compile",
        json={
            "goalContract": _item_goal_contract(
                transfer_contract.items[0], transfer_state
            ).model_dump(mode="json", by_alias=True, exclude_none=True),
            "bankStateSnapshot": transfer_state.model_dump(
                mode="json", by_alias=True, exclude_none=True
            ),
        },
    )
    assert transfer_single.status_code == 200
    assert "validUntil" not in transfer_single.json()["plan"]["validity"]
    data = tmp_path / "http.json"
    data.write_text(
        json.dumps({"bundles": cases, "singles": [single.json(), transfer_single.json()]})
    )
    runner = ROOT / "services/compiler/tests/verify_http_contracts.ts"
    checked = subprocess.run(
        [str(ROOT / "apps/api/node_modules/.bin/tsx"), str(runner), str(data)],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    assert checked.returncode == 0, checked.stdout + checked.stderr


def test_b13_acquisition_only_invalid_bank_balance_fails_closed():
    contract, state = headline(usd=20100)
    contract.items = [contract.items[1]]
    contract.explicit_dependencies = []
    state.accounts[0].available_minor_units = "invalid"
    refuse(contract, state, "INVALID_STATE_AMOUNT")


def test_b11_same_transfer_step_cannot_satisfy_two_requested_transfers():
    contract, state = headline()
    duplicate = contract.items[0].model_copy(deep=True)
    duplicate.item_id = "second-send"
    contract.items = [contract.items[0], duplicate]
    contract.explicit_dependencies = []
    result = success(contract, state)
    plan = result.financial_plan.model_copy(deep=True)
    proof = result.satisfaction_proof.model_copy(deep=True)
    plan.steps = [plan.steps[0]]
    proof.item_coverage[1].satisfied_by_step_ids = [plan.steps[0].id]
    payload = plan.model_dump(mode="json", by_alias=True, exclude_none=True)
    rehash_plan(payload)
    assert not validate_bundle_plan(contract, FinancialPlanV1.model_validate(payload), proof, state)


def test_b13_quote_rate_change_with_same_rounded_output_still_invalidates_plan_binding():
    contract, state = headline()
    result = success(contract, state)
    state.fx_quotes[0].rate = "0.75000001"
    assert not validate_bundle_plan(
        contract, result.financial_plan, result.satisfaction_proof, state
    )


def test_multiple_authorized_funding_accounts_respect_item_exclusions():
    from pydantic import TypeAdapter

    from app.models.contracts import GroundedGoalConstraintV1, GroundedPreferenceV1

    contract, state = headline()
    second = state.accounts[0].model_copy(deep=True)
    second.id = "second-sgd"
    second.capabilities = ["CONVERT_FX", "RECEIVE_TRANSFER"]
    state.accounts.append(second)
    contract.items[1].preferences.append(
        TypeAdapter(GroundedPreferenceV1).validate_python(
            {"type": "PREFER_ACCOUNT", "accountId": "second-sgd"}
        )
    )
    contract.items[1].constraints.append(
        TypeAdapter(GroundedGoalConstraintV1).validate_python(
            {"type": "EXCLUDED_ACCOUNT", "accountId": "second-sgd"}
        )
    )
    assert (
        success(contract, state).financial_plan.steps[1].parameters.source_account_id
        == "sgd-source"
    )


def test_custom_operation_allowlist_is_bound_and_enforced_in_bundle_proof():
    from app.policy.engine import PolicyEngine

    contract, state = headline(usd=20100)
    policy = PolicyEngine(frozenset({"TRANSFER", "BUY_ASSET"}))
    result = compile_goal_bundle(contract, state, policy)
    assert hasattr(result, "financial_plan")
    assert validate_bundle_plan(
        contract, result.financial_plan, result.satisfaction_proof, state, policy
    )
    restricted = PolicyEngine(frozenset({"TRANSFER"}))
    failure = compile_goal_bundle(contract, state, restricted)
    assert failure.status == "POLICY_BLOCKED"
    assert failure.reason.code == "OPERATION_NOT_ALLOWED"
    assert not validate_bundle_plan(
        contract, result.financial_plan, result.satisfaction_proof, state, restricted
    )


@pytest.mark.parametrize("quantity", ["1.0", "1.00", "0.50"])
def test_b12_equivalent_decimal_quantity_spellings_preserve_confirmed_quantity(quantity):
    contract, state = headline(usd=20100)
    contract.items[1].goal.quantity = quantity
    plan = success(contract, state).financial_plan
    assert plan.steps[-1].parameters.quantity == ("0.5" if quantity == "0.50" else "1")
    assert plan.steps[-1].parameters.authorized_total_minor == (
        "10100" if quantity == "0.50" else "20100"
    )
