"""Concrete integer checks only. No operation or route synthesis."""

from dataclasses import dataclass
from typing import Literal

from z3 import IntVal, Solver, sat


@dataclass(frozen=True)
class NumericCheck:
    kind: Literal["MINIMUM", "MAXIMUM"]
    actual: int
    limit: int


class ConstraintSolver:
    def check_minimum_balance(self, balance: int, spend: int, minimum: int) -> bool:
        return self.solve_numeric_constraints((NumericCheck("MINIMUM", balance - spend, minimum),))

    def check_maximum_cost(self, cost: int, maximum: int) -> bool:
        return self.solve_numeric_constraints((NumericCheck("MAXIMUM", cost, maximum),))

    def solve_numeric_constraints(self, checks: tuple[NumericCheck, ...]) -> bool:
        solver = Solver()
        for check in checks:
            if check.kind == "MINIMUM":
                solver.add(IntVal(check.actual) >= IntVal(check.limit))
            else:
                solver.add(IntVal(check.actual) <= IntVal(check.limit))
        return solver.check() == sat
