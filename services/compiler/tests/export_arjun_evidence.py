"""Export synthetic compiler HTTP evidence, never connect to a bank or database.

Run from services/compiler: PYTHONPATH=. ./.venv/bin/python tests/export_arjun_evidence.py
"""

import json
from copy import deepcopy
from pathlib import Path

from fastapi.testclient import TestClient
from test_arjun_bundle_safety import headline

from app.main import app
from app.models.contracts import FinancialPlanV1
from app.planner.bundle import _operation_from_step
from app.simulator.apply import apply_operation
from app.simulator.state import SimulatedState

OUTPUT = Path(__file__).resolve().parents[3] / "docs/arjun-compiler-evidence.json"


def main():
    client = TestClient(app)
    successes = []
    failures = []
    for name, options in (
        ("sgd-funded", {}),
        ("usd-funded", {"usd": 20100}),
        ("reserve-exact-boundary", {"sgd": 136825}),
        ("protected-balance", {"sgd": 136824}),
        ("insufficient-funding", {"sgd": 36824, "reserve": 0}),
        ("unauthorized-fx", {"authorize_fx": False}),
        ("asset-quote-unavailable", {}),
        ("asset-quote-expired", {}),
        ("fx-quote-unavailable", {}),
        ("fx-quote-expired", {}),
        ("asset-not-tradable", {}),
        ("asset-unknown", {}),
        ("beneficiary-currency", {}),
        ("beneficiary-unknown", {}),
        ("beneficiary-blocked", {}),
        ("settlement-currency", {}),
        ("invalid-dependency", {}),
    ):
        contract, state = headline(**options)
        if name == "asset-quote-unavailable":
            state.asset_quotes.clear()
        elif name == "asset-quote-expired":
            state.asset_quotes[0].expires_at = state.captured_at
        elif name == "fx-quote-unavailable":
            state.fx_quotes.clear()
        elif name == "fx-quote-expired":
            state.fx_quotes[0].expires_at = state.captured_at
        elif name == "asset-not-tradable":
            state.assets[0].tradable = False
        elif name == "asset-unknown":
            state.assets.clear()
        elif name == "beneficiary-currency":
            state.beneficiaries[0].supported_currencies = ["EUR"]
        elif name == "beneficiary-unknown":
            state.beneficiaries.clear()
        elif name == "beneficiary-blocked":
            state.beneficiaries[0].status = "BLOCKED"
        elif name == "settlement-currency":
            state.accounts[1].currency = "EUR"
        payload = contract.model_dump(mode="json", by_alias=True, exclude_none=True)
        if name == "invalid-dependency":
            payload["explicitDependencies"][0]["beforeItemId"] = "missing"
        request = {
            "goalBundle": payload,
            "bankState": state.model_dump(mode="json", by_alias=True, exclude_none=True),
        }
        response = client.post("/v1/compile-bundle", json=request)
        case = {
            "scenario": name,
            "request": request,
            "httpStatus": response.status_code,
            "response": response.json(),
        }
        if name in {"sgd-funded", "usd-funded", "reserve-exact-boundary"}:
            assert response.status_code == 200 and "financialPlan" in response.json()
            successes.append(case)
        else:
            assert response.status_code == 422 or response.json()["status"] in {
                "UNSAT",
                "POLICY_BLOCKED",
            }
            failures.append(case)

    first = successes[0]
    plan = FinancialPlanV1.model_validate(first["response"]["financialPlan"])
    state = SimulatedState.from_snapshot(headline()[1])
    prefixes = []
    for step in plan.steps:
        applied = apply_operation(state, _operation_from_step(step))
        assert applied.success
        state = applied.state
        prefixes.append(
            {
                "completedThroughStepId": step.id,
                "state": state.to_snapshot().model_dump(
                    mode="json", by_alias=True, exclude_none=True
                ),
            }
        )
    evidence = {
        "scope": "Synthetic, fixed-clock compiler evidence; no bank writes or approvals",
        "successFixtures": successes,
        "refusalFixtures": failures,
        "partialCompletion": prefixes,
        "unknownOutcome": {
            "status": "UNKNOWN",
            "goalAchieved": False,
            "requiredAction": (
                "Stop dependants; reconcile authoritative receipt/idempotency evidence"
            ),
            "possibleStates": [
                {"completedThroughStepId": None, "state": first["request"]["bankState"]},
                *deepcopy(prefixes),
            ],
            "rollbackClaim": False,
        },
    }
    OUTPUT.write_text(json.dumps(evidence, indent=2) + "\n")
    print(
        f"Exported {len(successes)} success, {len(failures)} refusal, "
        f"{len(prefixes)} prefix fixtures"
    )


if __name__ == "__main__":
    main()
