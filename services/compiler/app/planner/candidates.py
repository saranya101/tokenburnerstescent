"""Finite, deterministic concrete candidates. No route templates or language lookup."""

from decimal import ROUND_HALF_EVEN, Decimal, InvalidOperation

from app.models.contracts import (
    BankStateSnapshotV1,
    DeliverMoneyGroundedGoalV1,
    GoalContractV1,
    MoveFundsGroundedGoalV1,
)
from app.operations.library import operation_sort_key
from app.operations.models import FxConvert, InternalOperation, Money, MoveFunds, Transfer


def _funds(account) -> int:
    return min(int(account.available_minor_units), int(account.ledger_minor_units))


def _converted(amount: int, rate: Decimal) -> int:
    return int((Decimal(amount) * rate).quantize(Decimal("1"), rounding=ROUND_HALF_EVEN))


def _source_needed(target_minor_units: int, rate: Decimal) -> int:
    """Smallest positive source amount whose half-even rounded output meets target."""
    low, high = 1, 1
    while _converted(high, rate) < target_minor_units:
        high *= 2
    while low < high:
        middle = (low + high) // 2
        if _converted(middle, rate) >= target_minor_units:
            high = middle
        else:
            low = middle + 1
    return low


def _quotes(snapshot: BankStateSnapshotV1, target_currency: str):
    for quote in sorted(snapshot.fx_quotes, key=lambda item: item.id):
        if (
            quote.to_currency != target_currency
            or quote.from_currency == target_currency
            or quote.expires_at <= snapshot.captured_at
        ):
            continue
        try:
            rate = Decimal(quote.rate)
        except InvalidOperation:
            continue
        if rate.is_finite() and rate > 0:
            yield quote, rate


def enumerate_candidates(
    goal: GoalContractV1, snapshot: BankStateSnapshotV1
) -> tuple[InternalOperation, ...]:
    """Enumerate useful one-step moves, FX conversions, and grounded completion actions."""
    target = goal.goal
    accounts = sorted(
        (account for account in snapshot.accounts if account.status == "ACTIVE"),
        key=lambda account: account.id,
    )
    candidates: set[InternalOperation] = set()
    if isinstance(target, DeliverMoneyGroundedGoalV1):
        currency = target.amount.currency
        amount = int(target.amount.minor_units)
        for source in accounts:
            if (
                source.currency == currency
                and "SEND_TRANSFER" in source.capabilities
                and _funds(source) >= amount
            ):
                candidates.add(Transfer(source.id, target.recipient_id, Money(currency, amount)))
        # Move toward a transfer-capable account with a real shortfall. This also
        # handles aggregation from several partial source accounts.
        for destination in accounts:
            if (
                destination.currency != currency
                or "RECEIVE_TRANSFER" not in destination.capabilities
                or "SEND_TRANSFER" not in destination.capabilities
            ):
                continue
            deficit = amount - _funds(destination)
            if deficit <= 0:
                continue
            for source in accounts:
                if (
                    source.id != destination.id
                    and source.currency == currency
                    and "SEND_TRANSFER" in source.capabilities
                    and _funds(source) > 0
                ):
                    candidates.add(
                        MoveFunds(
                            source.id, destination.id, Money(currency, min(deficit, _funds(source)))
                        )
                    )
        # Quotes determine an exact minimum conversion or the maximum affordable
        # partial conversion. Multiple partial conversions may be explored.
        for quote, rate in _quotes(snapshot, currency):
            for destination in accounts:
                if (
                    destination.currency != currency
                    or "RECEIVE_TRANSFER" not in destination.capabilities
                    or "SEND_TRANSFER" not in destination.capabilities
                ):
                    continue
                deficit = amount - _funds(destination)
                if deficit <= 0:
                    continue
                needed = _source_needed(deficit, rate)
                fee = int(quote.fee.minor_units) if quote.fee is not None else 0
                if quote.fee is not None and quote.fee.currency != quote.from_currency:
                    continue
                for source in accounts:
                    if (
                        source.currency != quote.from_currency
                        or "CONVERT_FX" not in source.capabilities
                        or source.id == destination.id
                    ):
                        continue
                    available = _funds(source) - fee
                    if available <= 0:
                        continue
                    source_amount = min(needed, available)
                    if _converted(source_amount, rate) > 0:
                        candidates.add(
                            FxConvert(
                                source.id,
                                destination.id,
                                Money(source.currency, source_amount),
                                currency,
                                quote.id,
                            )
                        )
            # Move money toward a source account that could convert to target.
            for fx_source in accounts:
                if (
                    fx_source.currency != quote.from_currency
                    or "CONVERT_FX" not in fx_source.capabilities
                    or "RECEIVE_TRANSFER" not in fx_source.capabilities
                ):
                    continue
                for destination in accounts:
                    if (
                        destination.currency != currency
                        or "SEND_TRANSFER" not in destination.capabilities
                        or "RECEIVE_TRANSFER" not in destination.capabilities
                    ):
                        continue
                    deficit = amount - _funds(destination)
                    if deficit <= 0:
                        continue
                    fee = int(quote.fee.minor_units) if quote.fee is not None else 0
                    if quote.fee is not None and quote.fee.currency != quote.from_currency:
                        continue
                    needed = _source_needed(deficit, rate) + fee
                    shortage = needed - _funds(fx_source)
                    if shortage <= 0:
                        continue
                    for source in accounts:
                        if (
                            source.id != fx_source.id
                            and source.currency == fx_source.currency
                            and "SEND_TRANSFER" in source.capabilities
                            and _funds(source) > 0
                        ):
                            candidates.add(
                                MoveFunds(
                                    source.id,
                                    fx_source.id,
                                    Money(source.currency, min(shortage, _funds(source))),
                                )
                            )
    elif isinstance(target, MoveFundsGroundedGoalV1):
        currency = target.amount.currency
        amount = int(target.amount.minor_units)
        destination = next(
            (account for account in accounts if account.id == target.destination_account_id), None
        )
        if (
            destination is not None
            and destination.currency == currency
            and "RECEIVE_TRANSFER" in destination.capabilities
        ):
            for source in accounts:
                if (
                    source.id == destination.id
                    or source.currency != currency
                    or "SEND_TRANSFER" not in source.capabilities
                ):
                    continue
                if target.source_account_id is None or target.source_account_id == source.id:
                    if _funds(source) >= amount:
                        candidates.add(
                            MoveFunds(source.id, destination.id, Money(currency, amount))
                        )
            if target.source_account_id is not None:
                final_source = next(
                    (account for account in accounts if account.id == target.source_account_id),
                    None,
                )
                if final_source is not None and "RECEIVE_TRANSFER" in final_source.capabilities:
                    shortage = amount - _funds(final_source)
                    if shortage > 0:
                        for source in accounts:
                            if (
                                source.id not in (destination.id, final_source.id)
                                and source.currency == currency
                                and "SEND_TRANSFER" in source.capabilities
                                and _funds(source) > 0
                            ):
                                candidates.add(
                                    MoveFunds(
                                        source.id,
                                        final_source.id,
                                        Money(currency, min(shortage, _funds(source))),
                                    )
                                )
    return tuple(sorted(candidates, key=operation_sort_key))
