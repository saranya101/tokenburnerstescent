"""Classify external spending and fees without counting internal principal movement."""

from dataclasses import dataclass
from decimal import ROUND_HALF_EVEN, Decimal, InvalidOperation

from app.models.contracts import BankStateSnapshotV1
from app.operations.models import (
    BuyAsset,
    FxConvert,
    InternalOperation,
    MoveFunds,
    PayBill,
    SellAsset,
    Transfer,
)


@dataclass(frozen=True)
class CostEntry:
    currency: str
    minor_units: int
    action: str
    component: str
    operation_index: int = -1


@dataclass(frozen=True)
class CostAccountingResult:
    entries: tuple[CostEntry, ...]
    missing_quote_ids: tuple[str, ...] = ()
    invalid_operations: tuple[int, ...] = ()

    def total(self, currency: str) -> int:
        return sum(entry.minor_units for entry in self.entries if entry.currency == currency)

    def foreign_currencies(self, currency: str) -> tuple[str, ...]:
        return tuple(
            sorted(
                {
                    entry.currency
                    for entry in self.entries
                    if entry.currency != currency and entry.minor_units != 0
                }
            )
        )


def operation_amount(operation: InternalOperation) -> tuple[str, int]:
    if isinstance(operation, FxConvert):
        return operation.from_amount.currency, operation.from_amount.minor_units
    if isinstance(operation, (Transfer, MoveFunds, PayBill)):
        return operation.amount.currency, operation.amount.minor_units
    return operation.price.currency, operation.price.minor_units


def account_costs(
    snapshot: BankStateSnapshotV1, operations: tuple[InternalOperation, ...]
) -> CostAccountingResult:
    entries: list[CostEntry] = []
    missing: list[str] = []
    invalid: list[int] = []
    for index, operation in enumerate(operations):
        currency, amount = operation_amount(operation)
        if amount <= 0:
            invalid.append(index)
        if isinstance(operation, (Transfer, PayBill, BuyAsset)):
            entries.append(CostEntry(currency, amount, operation.action, "EXTERNAL_SPEND", index))
        if isinstance(operation, FxConvert):
            quote = next(
                (item for item in snapshot.fx_quotes if item.id == operation.quote_id), None
            )
            if quote is None:
                missing.append(operation.quote_id)
            elif quote.fee is not None:
                if int(quote.fee.minor_units) < 0:
                    invalid.append(index)
                entries.append(
                    CostEntry(
                        quote.fee.currency,
                        int(quote.fee.minor_units),
                        operation.action,
                        "FEE",
                        index,
                    )
                )
        elif operation.fee is not None:
            if operation.fee.minor_units < 0:
                invalid.append(index)
            entries.append(
                CostEntry(
                    operation.fee.currency,
                    operation.fee.minor_units,
                    operation.action,
                    "FEE",
                    index,
                )
            )
    return CostAccountingResult(
        tuple(entries), tuple(sorted(set(missing))), tuple(sorted(set(invalid)))
    )


@dataclass
class _FundedBalance:
    currency: str
    remaining_minor_units: int
    source_minor_units: int
    fx_operation_index: int
    counted: bool = False


def _trusted_fx_output(snapshot: BankStateSnapshotV1, operation: FxConvert) -> int | None:
    quote = next((item for item in snapshot.fx_quotes if item.id == operation.quote_id), None)
    if (
        quote is None
        or quote.expires_at <= snapshot.captured_at
        or quote.from_currency != operation.from_amount.currency
        or quote.to_currency != operation.to_currency
    ):
        return None
    try:
        rate = Decimal(quote.rate)
        if not rate.is_finite() or rate <= 0:
            return None
        # Match the C1 simulator: quote rates relate minor units directly.
        return int(
            (Decimal(operation.from_amount.minor_units) * rate).quantize(
                Decimal("1"), rounding=ROUND_HALF_EVEN
            )
        )
    except InvalidOperation:
        return None


def account_costs_for_limit(
    snapshot: BankStateSnapshotV1,
    operations: tuple[InternalOperation, ...],
    limit_currency: str,
) -> CostAccountingResult:
    """Recognize only provable single-FX funding of external spending.

    An initially empty destination receives one validated FX credit. A later
    external debit from that same account can consume the credit; the original
    source funding is then counted once in the limit currency. Mixed funds,
    unrelated foreign fees, and unsupported FX directions remain fail-closed.
    """
    base = account_costs(snapshot, operations)
    funded: dict[str, _FundedBalance] = {}
    tainted_accounts: set[str] = set()
    covered: set[int] = set()
    funding_entries: list[CostEntry] = []
    unusable_quotes = set(base.missing_quote_ids)
    entries = list(base.entries)

    for index, operation in enumerate(operations):
        if isinstance(operation, FxConvert):
            if operation.from_amount.currency != limit_currency:
                entries.append(
                    CostEntry(
                        operation.from_amount.currency,
                        operation.from_amount.minor_units,
                        operation.action,
                        "UNSUPPORTED_FX_FUNDING",
                        index,
                    )
                )
                funded.pop(operation.destination_account_id, None)
                tainted_accounts.add(operation.destination_account_id)
                continue
            output = _trusted_fx_output(snapshot, operation)
            if output is None or output <= 0:
                unusable_quotes.add(operation.quote_id)
                funded.pop(operation.destination_account_id, None)
                tainted_accounts.add(operation.destination_account_id)
                continue
            destination = next(
                (item for item in snapshot.accounts if item.id == operation.destination_account_id),
                None,
            )
            if (
                destination is None
                or destination.status != "ACTIVE"
                or "RECEIVE_TRANSFER" not in destination.capabilities
                or destination.currency != operation.to_currency
                or int(destination.available_minor_units) != 0
                or operation.destination_account_id in funded
                or operation.destination_account_id in tainted_accounts
            ):
                funded.pop(operation.destination_account_id, None)
                tainted_accounts.add(operation.destination_account_id)
                continue
            funded[operation.destination_account_id] = _FundedBalance(
                operation.to_currency, output, operation.from_amount.minor_units, index
            )
            continue

        if isinstance(operation, MoveFunds):
            # We do not infer ownership of a mixed balance after an internal credit.
            funded.pop(operation.source_account_id, None)
            funded.pop(operation.destination_account_id, None)
            tainted_accounts.add(operation.source_account_id)
            tainted_accounts.add(operation.destination_account_id)
            continue
        if isinstance(operation, SellAsset):
            funded.pop(operation.destination_account_id, None)
            tainted_accounts.add(operation.destination_account_id)
            continue
        if not isinstance(operation, (Transfer, PayBill, BuyAsset)):
            continue
        source_id = operation.source_account_id
        token = funded.get(source_id)
        currency, principal = operation_amount(operation)
        if token is None or currency == limit_currency or currency != token.currency:
            continue
        fee = operation.fee.minor_units if operation.fee is not None else 0
        if operation.fee is not None and operation.fee.currency != currency:
            funded.pop(source_id, None)
            tainted_accounts.add(source_id)
            continue
        debit = principal + fee
        if debit <= 0 or debit > token.remaining_minor_units:
            funded.pop(source_id, None)
            tainted_accounts.add(source_id)
            continue
        covered.add(index)
        token.remaining_minor_units -= debit
        if not token.counted:
            funding_entries.append(
                CostEntry(
                    limit_currency,
                    token.source_minor_units,
                    "FX_CONVERT",
                    "ATTRIBUTED_FUNDING",
                    token.fx_operation_index,
                )
            )
            token.counted = True

    entries = [
        entry
        for entry in entries
        if not (entry.operation_index in covered and entry.component in ("EXTERNAL_SPEND", "FEE"))
    ]
    entries.extend(funding_entries)
    return CostAccountingResult(
        tuple(entries), tuple(sorted(unusable_quotes)), base.invalid_operations
    )
