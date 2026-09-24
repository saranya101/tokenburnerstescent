import json
from pathlib import Path

import pytest
from pydantic import TypeAdapter

from app.models.contracts import (
    AcquireAssetGroundedGoalV1,
    AcquireAssetIntentGoalV1,
    ApprovalV1,
    BankStateSnapshotV1,
    CompilerResultV1,
    ExecutionResultV1,
    FinancialPlanV1,
    GoalContractV1,
    HardRule,
    IntentDraftV1,
)

FIXTURES = Path(__file__).parents[3] / "packages" / "contracts" / "fixtures"
ADAPTERS = {
    "intent-draft.json": TypeAdapter(IntentDraftV1),
    "goal-contract.json": TypeAdapter(GoalContractV1),
    "bank-state.json": TypeAdapter(BankStateSnapshotV1),
    "financial-plan.json": TypeAdapter(FinancialPlanV1),
    "compiler-result.json": TypeAdapter(CompilerResultV1),
    "compiler-unsat.json": TypeAdapter(CompilerResultV1),
    "approval.json": TypeAdapter(ApprovalV1),
    "execution-result.json": TypeAdapter(ExecutionResultV1),
    "hard-rule.json": TypeAdapter(HardRule),
}
FILES = sorted(path for path in FIXTURES.rglob("*.json"))


@pytest.mark.parametrize("path", FILES, ids=lambda path: str(path.relative_to(FIXTURES)))
def test_contract_fixture(path: Path) -> None:
    ADAPTERS[path.name].validate_python(json.loads(path.read_text()))


@pytest.mark.parametrize(
    "model,payload",
    [
        (
            AcquireAssetIntentGoalV1,
            {
                "type": "ACQUIRE_ASSET",
                "assetReference": "Apple",
                "budget": {"currency": "USD", "minorUnits": "10000"},
            },
        ),
        (
            AcquireAssetIntentGoalV1,
            {"type": "ACQUIRE_ASSET", "assetReference": "Apple", "quantity": "2.5"},
        ),
        (
            AcquireAssetGroundedGoalV1,
            {
                "type": "ACQUIRE_ASSET",
                "assetId": "asset-aapl",
                "budget": {"currency": "USD", "minorUnits": "10000"},
                "quantity": "2.5",
            },
        ),
    ],
)
def test_acquire_asset_valid_variants(model: type, payload: dict[str, object]) -> None:
    model.model_validate(payload)


@pytest.mark.parametrize(
    "model,id_field",
    [(AcquireAssetIntentGoalV1, "assetReference"), (AcquireAssetGroundedGoalV1, "assetId")],
)
def test_acquire_asset_rejects_missing_budget_and_quantity(model: type, id_field: str) -> None:
    with pytest.raises(ValueError, match="requires budget, quantity, or both"):
        model.model_validate({"type": "ACQUIRE_ASSET", id_field: "asset-aapl"})


def test_fx_step_requires_bound_destination() -> None:
    from app.models.contracts import FxConvertPlanStepV1

    step = {
        "id": "step-fx",
        "sequence": 0,
        "action": "FX_CONVERT",
        "dependsOn": [],
        "reversible": False,
        "parameters": {
            "sourceAccountId": "acc-sgd",
            "destinationAccountId": "acc-usd",
            "sourceMoney": {"currency": "SGD", "minorUnits": "100"},
            "targetCurrency": "USD",
            "quoteId": "quote-sgd-usd-1",
        },
    }
    assert FxConvertPlanStepV1.model_validate(step).parameters.destination_account_id == "acc-usd"
    del step["parameters"]["destinationAccountId"]
    with pytest.raises(ValueError):
        FxConvertPlanStepV1.model_validate(step)
