"""Pure operation simulator. Currency minor units are integer units, never floats.

FX quote rates multiply source minor units. The resulting target minor units are
rounded once with ROUND_HALF_EVEN; V1 has no currency exponent table. A quote fee
is charged separately in source minor units. Explicit trade price is the total
settlement amount for the concrete quantity, not a per-unit market quote.
"""

from dataclasses import dataclass, field
from decimal import ROUND_HALF_EVEN, Decimal, InvalidOperation
from typing import Any

from app.models.contracts import BankStateSnapshotV1, HoldingV1
from app.operations.library import OPERATION_LIBRARY
from app.operations.models import (
    BuyAsset,
    FxConvert,
    InternalOperation,
    Money,
    MoveFunds,
    PayBill,
    SellAsset,
    Transfer,
)
from app.policy.rules import (
    account_restrictions,
    asset_restriction,
    beneficiary_restriction,
    service_available,
)
from app.simulator.state import SimulatedState


@dataclass(frozen=True)
class OperationViolation:
    code: str
    details: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class OperationResult:
    state: SimulatedState | None
    violations: tuple[OperationViolation, ...]
    action: str
    reversible: bool
    # Fee/cost are fully explicit. A failed operation reports no incurred costs.
    fee: Money | None = None
    cost: Money | None = None

    @property
    def success(self) -> bool:
        return self.state is not None


def _violation(code: str, **details: Any) -> OperationViolation:
    return OperationViolation(code, details)


def _account(snapshot: BankStateSnapshotV1, account_id: str, role: str, errors: list):
    account = next((item for item in snapshot.accounts if item.id == account_id), None)
    if account is None:
        errors.append(_violation("ACCOUNT_NOT_FOUND", accountId=account_id, role=role))
    elif account_restrictions(account):
        errors.append(_violation("ACCOUNT_INACTIVE", accountId=account_id, status=account.status))
    return account


def _capability(account, capability: str, errors: list):
    if account is not None and "ACCOUNT_CAPABILITY_MISSING" in account_restrictions(
        account, capability
    ):
        errors.append(
            _violation(
                "UNSUPPORTED_ACCOUNT_CAPABILITY", accountId=account.id, capability=capability
            )
        )


def _currency(actual: str, expected: str, errors: list, **details: Any):
    if actual != expected:
        errors.append(_violation("CURRENCY_MISMATCH", actual=actual, expected=expected, **details))


def _positive(amount: Money, errors: list):
    if amount.minor_units <= 0:
        errors.append(_violation("INVALID_AMOUNT", minorUnits=amount.minor_units))


def _quantity(quantity: Decimal, errors: list):
    if not quantity.is_finite() or quantity <= 0:
        errors.append(_violation("INVALID_QUANTITY", quantity=str(quantity)))


def _fee(fee: Money | None, currency: str, errors: list) -> int:
    if fee is None:
        return 0
    _currency(fee.currency, currency, errors, field="fee")
    if fee.minor_units < 0:
        errors.append(_violation("INVALID_FEE", minorUnits=fee.minor_units))
    return fee.minor_units


def _funds(account, debit: int, errors: list):
    if account is not None and debit > int(account.available_minor_units):
        errors.append(
            _violation(
                "INSUFFICIENT_FUNDS",
                accountId=account.id,
                requiredMinorUnits=debit,
                availableMinorUnits=account.available_minor_units,
            )
        )
    if account is not None and debit > int(account.ledger_minor_units):
        errors.append(
            _violation(
                "INSUFFICIENT_LEDGER",
                accountId=account.id,
                requiredMinorUnits=debit,
                ledgerMinorUnits=account.ledger_minor_units,
            )
        )


def _debit(account, amount: int):
    account.available_minor_units = str(int(account.available_minor_units) - amount)
    account.ledger_minor_units = str(int(account.ledger_minor_units) - amount)


def _credit(account, amount: int):
    account.available_minor_units = str(int(account.available_minor_units) + amount)
    account.ledger_minor_units = str(int(account.ledger_minor_units) + amount)


def _asset(snapshot, asset_id: str, errors: list):
    asset = next((item for item in snapshot.assets if item.id == asset_id), None)
    if asset is None:
        errors.append(_violation("ASSET_NOT_FOUND", assetId=asset_id))
    elif asset_restriction(asset):
        errors.append(_violation("ASSET_NOT_TRADABLE", assetId=asset_id))
    return asset


def _decimal_string(value: Decimal) -> str:
    return format(value.normalize(), "f")


def apply_operation(
    state: BankStateSnapshotV1 | SimulatedState, operation: InternalOperation
) -> OperationResult:
    simulated = state if isinstance(state, SimulatedState) else SimulatedState.from_snapshot(state)
    snapshot = simulated.to_snapshot()
    errors: list[OperationViolation] = []
    definition = OPERATION_LIBRARY[operation.action]
    if not service_available(snapshot, definition.availability):
        errors.append(_violation("SERVICE_UNAVAILABLE", service=definition.availability))
    fee: Money | None = None
    cost: Money | None = None

    if isinstance(operation, (Transfer, MoveFunds, PayBill)):
        amount = operation.amount
        _positive(amount, errors)
        source = _account(snapshot, operation.source_account_id, "source", errors)
        capability = "PAY_BILL" if isinstance(operation, PayBill) else "SEND_TRANSFER"
        _capability(source, capability, errors)
        if source is not None:
            _currency(source.currency, amount.currency, errors, accountId=source.id)
        fee_units = _fee(operation.fee, amount.currency, errors)
        _funds(source, amount.minor_units + fee_units, errors)
        if isinstance(operation, Transfer):
            beneficiary = next(
                (item for item in snapshot.beneficiaries if item.id == operation.beneficiary_id),
                None,
            )
            if beneficiary is None:
                errors.append(
                    _violation("BENEFICIARY_NOT_FOUND", beneficiaryId=operation.beneficiary_id)
                )
            else:
                if beneficiary_restriction(beneficiary):
                    errors.append(
                        _violation(
                            "BENEFICIARY_NOT_VERIFIED",
                            beneficiaryId=beneficiary.id,
                            status=beneficiary.status,
                        )
                    )
                if amount.currency not in beneficiary.supported_currencies:
                    errors.append(
                        _violation(
                            "CURRENCY_MISMATCH",
                            beneficiaryId=beneficiary.id,
                            currency=amount.currency,
                        )
                    )
        elif isinstance(operation, MoveFunds):
            destination = _account(
                snapshot, operation.destination_account_id, "destination", errors
            )
            _capability(destination, "RECEIVE_TRANSFER", errors)
            if destination is not None:
                _currency(destination.currency, amount.currency, errors, accountId=destination.id)
            if source is not None and destination is not None and source.id == destination.id:
                errors.append(_violation("SAME_ACCOUNT", accountId=source.id))
        else:
            obligation = next(
                (item for item in snapshot.obligations if item.id == operation.obligation_id), None
            )
            if obligation is None:
                errors.append(
                    _violation("OBLIGATION_NOT_FOUND", obligationId=operation.obligation_id)
                )
            else:
                if obligation.status not in ("OPEN", "OVERDUE"):
                    errors.append(
                        _violation(
                            "OBLIGATION_NOT_PAYABLE",
                            obligationId=obligation.id,
                            status=obligation.status,
                        )
                    )
                _currency(
                    obligation.money.currency, amount.currency, errors, obligationId=obligation.id
                )
                if amount.minor_units > int(obligation.money.minor_units):
                    errors.append(
                        _violation("AMOUNT_EXCEEDS_OBLIGATION", obligationId=obligation.id)
                    )
        if not errors:
            _debit(source, amount.minor_units + fee_units)
            if isinstance(operation, MoveFunds):
                _credit(destination, amount.minor_units)
            elif isinstance(operation, PayBill):
                remaining = int(obligation.money.minor_units) - amount.minor_units
                obligation.money.minor_units = str(remaining)
                if remaining == 0:
                    obligation.status = "PAID"
            fee = Money(amount.currency, fee_units)
            cost = Money(amount.currency, amount.minor_units + fee_units)

    elif isinstance(operation, FxConvert):
        source = _account(snapshot, operation.source_account_id, "source", errors)
        destination = _account(snapshot, operation.destination_account_id, "destination", errors)
        _capability(source, "CONVERT_FX", errors)
        _capability(destination, "RECEIVE_TRANSFER", errors)
        _positive(operation.from_amount, errors)
        if source is not None:
            _currency(source.currency, operation.from_amount.currency, errors, accountId=source.id)
        if destination is not None:
            _currency(destination.currency, operation.to_currency, errors, accountId=destination.id)
        if source is not None and destination is not None and source.id == destination.id:
            errors.append(_violation("SAME_ACCOUNT", accountId=source.id))
        quote = next((item for item in snapshot.fx_quotes if item.id == operation.quote_id), None)
        fee_units = 0
        converted = 0
        if quote is None:
            errors.append(_violation("QUOTE_NOT_FOUND", quoteId=operation.quote_id))
        else:
            if quote.expires_at <= snapshot.captured_at:
                errors.append(
                    _violation(
                        "QUOTE_EXPIRED",
                        quoteId=quote.id,
                        expiresAt=quote.expires_at.isoformat(),
                        asOf=snapshot.captured_at.isoformat(),
                    )
                )
            if (
                quote.from_currency != operation.from_amount.currency
                or quote.to_currency != operation.to_currency
            ):
                errors.append(
                    _violation(
                        "CURRENCY_MISMATCH",
                        quoteId=quote.id,
                        quotePair=[quote.from_currency, quote.to_currency],
                        requestedPair=[operation.from_amount.currency, operation.to_currency],
                    )
                )
            if quote.fee is not None:
                fee_units = _fee(
                    Money(quote.fee.currency, int(quote.fee.minor_units)),
                    operation.from_amount.currency,
                    errors,
                )
            try:
                rate = Decimal(quote.rate)
                if not rate.is_finite() or rate <= 0:
                    raise InvalidOperation
                converted = int(
                    (Decimal(operation.from_amount.minor_units) * rate).quantize(
                        Decimal("1"), rounding=ROUND_HALF_EVEN
                    )
                )
                if converted <= 0:
                    errors.append(_violation("INVALID_AMOUNT", convertedMinorUnits=converted))
            except InvalidOperation:
                errors.append(_violation("INVALID_RATE", quoteId=quote.id, rate=quote.rate))
        _funds(source, operation.from_amount.minor_units + fee_units, errors)
        if not errors:
            _debit(source, operation.from_amount.minor_units + fee_units)
            _credit(destination, converted)
            fee = Money(operation.from_amount.currency, fee_units)
            cost = Money(
                operation.from_amount.currency, operation.from_amount.minor_units + fee_units
            )

    elif isinstance(operation, (BuyAsset, SellAsset)):
        buying = isinstance(operation, BuyAsset)
        account_id = operation.source_account_id if buying else operation.destination_account_id
        account = _account(snapshot, account_id, "source" if buying else "destination", errors)
        _capability(account, "TRADE_ASSET", errors)
        asset = _asset(snapshot, operation.asset_id, errors)
        _quantity(operation.quantity, errors)
        _positive(operation.price, errors)
        fee_units = _fee(operation.fee, operation.price.currency, errors)
        if asset is not None:
            _currency(asset.settlement_currency, operation.price.currency, errors, assetId=asset.id)
        if account is not None:
            _currency(account.currency, operation.price.currency, errors, accountId=account.id)
        holding = next(
            (item for item in snapshot.holdings if item.asset_id == operation.asset_id), None
        )
        if buying:
            debit = operation.price.minor_units + fee_units
            _funds(account, debit, errors)
            if operation.maximum_spend is not None:
                _currency(
                    operation.maximum_spend.currency,
                    operation.price.currency,
                    errors,
                    field="maximumSpend",
                )
                if debit > operation.maximum_spend.minor_units:
                    errors.append(
                        _violation(
                            "MAXIMUM_SPEND_EXCEEDED",
                            requiredMinorUnits=debit,
                            maximumMinorUnits=operation.maximum_spend.minor_units,
                        )
                    )
        else:
            held = Decimal(holding.quantity) if holding is not None else Decimal(0)
            if operation.quantity.is_finite() and operation.quantity > held:
                errors.append(
                    _violation(
                        "INSUFFICIENT_HOLDING",
                        assetId=operation.asset_id,
                        requested=str(operation.quantity),
                        available=str(held),
                    )
                )
            if fee_units > operation.price.minor_units:
                errors.append(
                    _violation(
                        "INVALID_FEE",
                        feeMinorUnits=fee_units,
                        priceMinorUnits=operation.price.minor_units,
                    )
                )
        if not errors:
            if buying:
                _debit(account, debit)
                if holding is None:
                    snapshot.holdings.append(
                        HoldingV1(
                            assetId=operation.asset_id, quantity=_decimal_string(operation.quantity)
                        )
                    )
                else:
                    holding.quantity = _decimal_string(
                        Decimal(holding.quantity) + operation.quantity
                    )
                cost = Money(operation.price.currency, debit)
            else:
                holding.quantity = _decimal_string(Decimal(holding.quantity) - operation.quantity)
                _credit(account, operation.price.minor_units - fee_units)
                cost = Money(operation.price.currency, fee_units)
            fee = Money(operation.price.currency, fee_units)

    if errors:
        return OperationResult(None, tuple(errors), operation.action, definition.reversible)
    return OperationResult(
        simulated.advanced(snapshot), (), operation.action, definition.reversible, fee, cost
    )
