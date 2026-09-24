"""Available liquidity means ACTIVE-account availableMinorUnits, never ledger funds."""

from app.models.contracts import BankStateSnapshotV1
from app.simulator.state import SimulatedState


def available_liquidity(
    state: BankStateSnapshotV1 | SimulatedState, currency: str, account_id: str | None = None
) -> int:
    snapshot = state.to_snapshot() if isinstance(state, SimulatedState) else state
    return sum(
        int(account.available_minor_units)
        for account in snapshot.accounts
        if account.status == "ACTIVE"
        and account.currency == currency
        and (account_id is None or account.id == account_id)
    )
