import json
from pathlib import Path

from fastapi.testclient import TestClient

from app.main import app


def test_health() -> None:
    response = TestClient(app).get("/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_compile_endpoint_returns_a_single_buy_asset_plan() -> None:
    fixture = (
        Path(__file__).resolve().parents[3] / "packages/contracts/fixtures/02-apple-investment"
    )
    goal = json.loads((fixture / "goal-contract.json").read_text())
    goal["goal"] = {"type": "ACQUIRE_ASSET", "assetId": "asset-aapl", "quantity": "1"}
    state = json.loads((fixture / "bank-state.json").read_text())
    response = TestClient(app).post(
        "/v1/compile",
        json={"goalContract": goal, "bankStateSnapshot": state},
    )
    assert response.status_code == 200
    result = response.json()
    assert result["status"] == "SAT"
    assert "deliveredMoney" not in result["plan"]["projectedOutcome"]
    assert [step["action"] for step in result["plan"]["steps"]] == ["BUY_ASSET"]
    assert result["plan"]["steps"][0]["parameters"]["authorizedTotalMinor"] == "20100"


def test_compile_endpoint_returns_parseable_conditional_fx_investment_plan() -> None:
    fixture = (
        Path(__file__).resolve().parents[3] / "packages/contracts/fixtures/02-apple-investment"
    )
    goal = json.loads((fixture / "goal-contract.json").read_text())
    goal["goal"] = {"type": "ACQUIRE_ASSET", "assetId": "asset-aapl", "quantity": "1"}
    goal["constraints"] = [
        {
            "type": "MIN_AVAILABLE_BALANCE",
            "money": {"currency": "SGD", "minorUnits": "100000"},
            "accountId": "acc-sgd",
        }
    ]
    goal["preferences"] = [{"type": "PREFER_ACCOUNT", "accountId": "acc-sgd"}]
    goal["entityBindings"].append(
        {
            "schemaVersion": "1",
            "reference": "my SGD account",
            "entityType": "ACCOUNT",
            "entityId": "acc-sgd",
            "resolutionMethod": "ALIAS",
            "confirmed": True,
        }
    )
    state = json.loads((fixture / "bank-state.json").read_text())
    state["accounts"][0].update({"ledgerMinorUnits": "0", "availableMinorUnits": "0"})
    state["accounts"][0]["capabilities"].append("RECEIVE_TRANSFER")
    state["accounts"].append(
        {
            "id": "acc-sgd",
            "type": "CHECKING",
            "currency": "SGD",
            "ledgerMinorUnits": "1732001",
            "availableMinorUnits": "1732001",
            "status": "ACTIVE",
            "capabilities": ["CONVERT_FX"],
        }
    )
    state["fxQuotes"] = [
        {
            "id": "quote-sgd-usd-investment",
            "fromCurrency": "SGD",
            "toCurrency": "USD",
            "rate": "0.75",
            "expiresAt": "2099-01-01T00:00:00.000Z",
        }
    ]

    response = TestClient(app).post(
        "/v1/compile",
        json={"goalContract": goal, "bankStateSnapshot": state},
    )

    assert response.status_code == 200
    result = response.json()
    assert result["status"] == "SAT"
    assert [step["action"] for step in result["plan"]["steps"]] == [
        "FX_CONVERT",
        "BUY_ASSET",
    ]
    assert result["plan"]["steps"][1]["dependsOn"] == [result["plan"]["steps"][0]["id"]]
    assert "deliveredMoney" not in result["plan"]["projectedOutcome"]
    assert result["plan"]["projectedOutcome"]["projectedAvailableBalances"] == [
        {"accountId": "acc-brokerage", "money": {"currency": "USD", "minorUnits": "0"}},
        {
            "accountId": "acc-sgd",
            "money": {"currency": "SGD", "minorUnits": "1705201"},
        },
    ]
