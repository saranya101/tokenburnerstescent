from typing import Protocol

from app.models.contracts import BankStateSnapshotV1, CompilerResultV1, GoalContractV1


class Planner(Protocol):
    """Future graph-search + Z3 planner boundary."""

    def plan(self, goal: GoalContractV1, state: BankStateSnapshotV1) -> CompilerResultV1: ...
