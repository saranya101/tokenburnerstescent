from z3 import Real, Solver, sat, unsat


def liquidity_result(balance: int, spend: int, minimum: int):
    remaining = Real("remaining")
    solver = Solver()
    solver.add(remaining == balance - spend, remaining >= minimum)
    return solver.check()


def test_minimum_liquidity_can_be_sat() -> None:
    assert liquidity_result(100, 40, 50) == sat


def test_minimum_liquidity_can_be_unsat() -> None:
    assert liquidity_result(100, 60, 50) == unsat
