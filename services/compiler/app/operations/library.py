from app.models.contracts import OperationDefinitionV1


def _operation(name: str, parameters: list[str], reversible: bool) -> OperationDefinitionV1:
    return OperationDefinitionV1(
        name=name,
        parameters=parameters,
        preconditions=["policy_allows", "sufficient_state"],
        effects=["bank_state_changes"],
        cost_model="TODO: deterministic fee model",
        availability="TODO: query preflight adapter",
        reversible=reversible,
    )


OPERATION_LIBRARY = {
    "TRANSFER": _operation(
        "TRANSFER", ["sourceAccountId", "beneficiaryId", "amount", "currency"], False
    ),
    "FX_CONVERT": _operation(
        "FX_CONVERT", ["accountId", "fromCurrency", "toCurrency", "amount", "quoteId"], False
    ),
    "MOVE_FUNDS": _operation(
        "MOVE_FUNDS", ["sourceAccountId", "targetAccountId", "amount", "currency"], True
    ),
    "PAY_BILL": _operation("PAY_BILL", ["accountId", "billReference", "amount", "currency"], False),
    "BUY_ASSET": _operation("BUY_ASSET", ["accountId", "symbol", "quantity"], False),
    "SELL_ASSET": _operation("SELL_ASSET", ["accountId", "symbol", "quantity"], False),
}
