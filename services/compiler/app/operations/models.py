"""Concrete, fully grounded operation inputs for state simulation."""

from dataclasses import dataclass
from decimal import Decimal
from typing import Literal


@dataclass(frozen=True)
class Money:
    currency: str
    minor_units: int


@dataclass(frozen=True)
class Transfer:
    source_account_id: str
    beneficiary_id: str
    amount: Money
    fee: Money | None = None
    action: Literal["TRANSFER"] = "TRANSFER"


@dataclass(frozen=True)
class FxConvert:
    source_account_id: str
    destination_account_id: str
    from_amount: Money
    to_currency: str
    quote_id: str
    action: Literal["FX_CONVERT"] = "FX_CONVERT"


@dataclass(frozen=True)
class MoveFunds:
    source_account_id: str
    destination_account_id: str
    amount: Money
    fee: Money | None = None
    action: Literal["MOVE_FUNDS"] = "MOVE_FUNDS"


@dataclass(frozen=True)
class PayBill:
    source_account_id: str
    obligation_id: str
    amount: Money
    fee: Money | None = None
    action: Literal["PAY_BILL"] = "PAY_BILL"


@dataclass(frozen=True)
class BuyAsset:
    source_account_id: str
    asset_id: str
    quantity: Decimal
    price: Money
    fee: Money | None = None
    maximum_spend: Money | None = None
    action: Literal["BUY_ASSET"] = "BUY_ASSET"


@dataclass(frozen=True)
class SellAsset:
    destination_account_id: str
    asset_id: str
    quantity: Decimal
    price: Money
    fee: Money | None = None
    action: Literal["SELL_ASSET"] = "SELL_ASSET"


InternalOperation = Transfer | FxConvert | MoveFunds | PayBill | BuyAsset | SellAsset
