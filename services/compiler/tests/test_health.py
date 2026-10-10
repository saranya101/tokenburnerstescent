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
    assert [step["action"] for step in result["plan"]["steps"]] == ["BUY_ASSET"]
    assert result["plan"]["steps"][0]["parameters"]["authorizedTotalMinor"] == "20100"
