import json
from pathlib import Path

import pytest
from pydantic import TypeAdapter

from app.models.contracts import (
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
