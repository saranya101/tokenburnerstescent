"""Deterministic operation definitions. Parameter names match internal operation inputs."""

import json
from dataclasses import asdict
from decimal import Decimal

from app.models.contracts import OperationDefinitionV1
from app.operations.models import InternalOperation

ACTION_ORDER = ("TRANSFER", "FX_CONVERT", "MOVE_FUNDS", "PAY_BILL", "BUY_ASSET", "SELL_ASSET")


def operation_sort_key(operation: InternalOperation) -> tuple[int, str]:
    """Stable internal candidate order independent of dict/set iteration order."""

    def normalize(value):
        if isinstance(value, Decimal):
            return format(value.normalize(), "f")
        if isinstance(value, dict):
            return {key: normalize(item) for key, item in value.items()}
        if isinstance(value, list):
            return [normalize(item) for item in value]
        return value

    payload = json.dumps(normalize(asdict(operation)), sort_keys=True, separators=(",", ":"))
    return ACTION_ORDER.index(operation.action), payload


def _definition(name, parameters, preconditions, effects, availability, reversible, cost_model):
    return OperationDefinitionV1(
        name=name,
        parameters=parameters,
        preconditions=preconditions,
        effects=effects,
        availability=availability,
        reversible=reversible,
        cost_model=cost_model,
    )


OPERATION_LIBRARY = {
    "TRANSFER": _definition(
        "TRANSFER",
        ["source_account_id", "beneficiary_id", "amount", "fee"],
        [
            "active_source",
            "SEND_TRANSFER",
            "active_beneficiary",
            "matching_currency",
            "positive_amount",
            "sufficient_available",
            "transfers_available",
        ],
        ["debit_source_amount_and_fee"],
        "transfers",
        False,
        "explicit fee in source currency; default zero",
    ),
    "FX_CONVERT": _definition(
        "FX_CONVERT",
        ["source_account_id", "destination_account_id", "from_amount", "to_currency", "quote_id"],
        [
            "active_source",
            "CONVERT_FX",
            "active_destination",
            "RECEIVE_TRANSFER",
            "valid_quote",
            "positive_amount",
            "sufficient_available",
            "fx_available",
        ],
        ["debit_source_amount_and_quote_fee", "credit_destination_rounded_conversion"],
        "fx",
        False,
        "quote fee in source currency; half-even rounding to target minor unit",
    ),
    "MOVE_FUNDS": _definition(
        "MOVE_FUNDS",
        ["source_account_id", "destination_account_id", "amount", "fee"],
        [
            "active_accounts",
            "SEND_TRANSFER",
            "RECEIVE_TRANSFER",
            "matching_currency",
            "positive_amount",
            "sufficient_available",
            "transfers_available",
        ],
        ["debit_source_amount_and_fee", "credit_destination_amount"],
        "transfers",
        True,
        "explicit fee in source currency; default zero",
    ),
    "PAY_BILL": _definition(
        "PAY_BILL",
        ["source_account_id", "obligation_id", "amount", "fee"],
        [
            "active_source",
            "PAY_BILL",
            "open_obligation",
            "matching_currency",
            "positive_amount",
            "sufficient_available",
            "bill_payments_available",
        ],
        ["debit_source_amount_and_fee", "reduce_or_close_obligation"],
        "billPayments",
        False,
        "explicit fee in source currency; default zero",
    ),
    "BUY_ASSET": _definition(
        "BUY_ASSET",
        ["source_account_id", "asset_id", "quantity", "price", "fee", "maximum_spend"],
        [
            "active_source",
            "TRADE_ASSET",
            "tradable_asset",
            "settlement_currency",
            "positive_quantity",
            "positive_price",
            "sufficient_available",
            "investments_available",
        ],
        ["debit_source_price_and_fee", "increase_holding"],
        "investments",
        False,
        "explicit total price and fee; no market lookup",
    ),
    "SELL_ASSET": _definition(
        "SELL_ASSET",
        ["destination_account_id", "asset_id", "quantity", "price", "fee"],
        [
            "active_destination",
            "TRADE_ASSET",
            "tradable_asset",
            "settlement_currency",
            "positive_quantity",
            "sufficient_holding",
            "positive_price",
            "investments_available",
        ],
        ["decrease_holding", "credit_destination_price_less_fee"],
        "investments",
        False,
        "explicit total price and fee; no market lookup",
    ),
}

# Internal machine-readable failure vocabulary; V1 wire definitions have no error field.
COMMON_ACCOUNT_ERRORS = frozenset(
    {"ACCOUNT_NOT_FOUND", "ACCOUNT_INACTIVE", "UNSUPPORTED_ACCOUNT_CAPABILITY", "CURRENCY_MISMATCH"}
)
COMMON_AMOUNT_ERRORS = frozenset(
    {"INVALID_AMOUNT", "INVALID_FEE", "INSUFFICIENT_FUNDS", "INSUFFICIENT_LEDGER"}
)
OPERATION_VIOLATIONS = {
    "TRANSFER": COMMON_ACCOUNT_ERRORS
    | COMMON_AMOUNT_ERRORS
    | {"SERVICE_UNAVAILABLE", "BENEFICIARY_NOT_FOUND", "BENEFICIARY_NOT_VERIFIED"},
    "FX_CONVERT": COMMON_ACCOUNT_ERRORS
    | COMMON_AMOUNT_ERRORS
    | {"SERVICE_UNAVAILABLE", "QUOTE_NOT_FOUND", "QUOTE_EXPIRED", "INVALID_RATE", "SAME_ACCOUNT"},
    "MOVE_FUNDS": COMMON_ACCOUNT_ERRORS
    | COMMON_AMOUNT_ERRORS
    | {"SERVICE_UNAVAILABLE", "SAME_ACCOUNT"},
    "PAY_BILL": COMMON_ACCOUNT_ERRORS
    | COMMON_AMOUNT_ERRORS
    | {
        "SERVICE_UNAVAILABLE",
        "OBLIGATION_NOT_FOUND",
        "OBLIGATION_NOT_PAYABLE",
        "AMOUNT_EXCEEDS_OBLIGATION",
    },
    "BUY_ASSET": COMMON_ACCOUNT_ERRORS
    | COMMON_AMOUNT_ERRORS
    | {
        "SERVICE_UNAVAILABLE",
        "ASSET_NOT_FOUND",
        "ASSET_NOT_TRADABLE",
        "INVALID_QUANTITY",
        "MAXIMUM_SPEND_EXCEEDED",
    },
    "SELL_ASSET": COMMON_ACCOUNT_ERRORS
    | {
        "SERVICE_UNAVAILABLE",
        "ASSET_NOT_FOUND",
        "ASSET_NOT_TRADABLE",
        "INVALID_QUANTITY",
        "INVALID_AMOUNT",
        "INVALID_FEE",
        "INSUFFICIENT_HOLDING",
    },
}
