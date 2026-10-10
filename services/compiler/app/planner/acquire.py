"""Shared deterministic planning for a grounded asset acquisition."""

from decimal import Decimal, InvalidOperation

from app.constraints.evaluator import evaluate_constraints
from app.models.contracts import (
    AcquireAssetGroundedGoalV1,
    BankStateSnapshotV1,
    CompilerPolicyBlockedV1,
    CompilerReasonV1,
    CompilerUnsatV1,
    GoalContractV1,
    HardRule,
)
from app.operations.models import BuyAsset, Money
from app.policy.engine import PolicyEngine
from app.simulator.apply import apply_operation
from app.simulator.state import SimulatedState


def _unsat(code: str, context: dict[str, object], **details: object) -> CompilerUnsatV1:
    return CompilerUnsatV1(
        schemaVersion="1",
        status="UNSAT",
        reason=CompilerReasonV1(
            code=code,
            message=code.replace("_", " ").capitalize(),
            details={**context, **details} or None,
        ),
        relaxations=[],
    )


def _blocked(code: str, context: dict[str, object], **details: object) -> CompilerPolicyBlockedV1:
    return CompilerPolicyBlockedV1(
        schemaVersion="1",
        status="POLICY_BLOCKED",
        reason=CompilerReasonV1(
            code=code,
            message=code.replace("_", " ").capitalize(),
            details={**context, **details} or None,
        ),
    )


def compile_acquire_operation(
    goal_contract: GoalContractV1,
    snapshot: BankStateSnapshotV1,
    policy: PolicyEngine,
    hard_rules: tuple[HardRule, ...] = (),
    context: dict[str, object] | None = None,
) -> BuyAsset | CompilerUnsatV1 | CompilerPolicyBlockedV1:
    """Produce one fully quoted purchase or a controlled fail-closed result."""
    details = context or {}
    goal = goal_contract.goal
    assert isinstance(goal, AcquireAssetGroundedGoalV1)
    if goal.quantity is not None and Decimal(goal.quantity) <= 0:
        return _unsat("INVALID_QUANTITY", details, quantity=goal.quantity)
    if goal.budget is not None and int(goal.budget.minor_units) <= 0:
        return _unsat(
            "INVALID_AMOUNT",
            details,
            currency=goal.budget.currency,
            minorUnits=goal.budget.minor_units,
        )
    if "BUY_ASSET" not in policy.allowed_operations:
        return _blocked("OPERATION_NOT_ALLOWED", details, action="BUY_ASSET")
    asset = next(
        (candidate for candidate in snapshot.assets if candidate.id == goal.asset_id), None
    )
    if asset is None:
        return _unsat("ASSET_NOT_FOUND", details, assetId=goal.asset_id)
    if not asset.tradable:
        return _blocked("ASSET_NOT_TRADABLE", details, assetId=goal.asset_id)
    if not snapshot.service_availability.investments:
        return _blocked("REQUIRED_SERVICE_UNAVAILABLE", details, service="investments")
    eligible_accounts = [
        account
        for account in snapshot.accounts
        if account.status == "ACTIVE"
        and account.currency == asset.settlement_currency
        and "TRADE_ASSET" in account.capabilities
    ]
    if not eligible_accounts:
        return _unsat(
            "NO_ELIGIBLE_SETTLEMENT_ACCOUNT",
            details,
            assetId=goal.asset_id,
            settlementCurrency=asset.settlement_currency,
        )
    quotes = sorted(
        (
            quote
            for quote in snapshot.asset_quotes
            if quote.asset_id == asset.id
            and quote.settlement_currency == asset.settlement_currency
            and quote.expires_at > snapshot.captured_at
        ),
        key=lambda quote: (quote.expires_at, quote.quote_id),
    )
    if not quotes:
        return _unsat("ASSET_PRICE_UNAVAILABLE", details, assetId=goal.asset_id)
    quote = quotes[0]
    unit_price = int(quote.unit_price_minor)
    fee = int(quote.fee_minor)
    if unit_price <= 0:
        return _unsat("ASSET_PRICE_INVALID", details, quoteId=quote.quote_id)
    budget = int(goal.budget.minor_units) if goal.budget is not None else None
    if goal.budget is not None and goal.budget.currency != quote.settlement_currency:
        return _unsat(
            "CURRENCY_MISMATCH",
            details,
            expected=quote.settlement_currency,
            actual=goal.budget.currency,
        )
    try:
        quantity = (
            Decimal(goal.quantity)
            if goal.quantity is not None
            else Decimal((budget - fee) // unit_price)
        )
        quoted_price = quantity * Decimal(unit_price)
    except (InvalidOperation, TypeError):
        return _unsat("INVALID_QUANTITY", details, quantity=goal.quantity)
    if quantity <= 0 or not quantity.is_finite():
        return _unsat("BUDGET_BELOW_MINIMUM_PURCHASE", details)
    if quoted_price != quoted_price.to_integral_value():
        return _unsat("ASSET_QUOTE_NOT_MINOR_UNIT_EXACT", details, quoteId=quote.quote_id)
    authorized_total = int(quoted_price) + fee
    if budget is not None and authorized_total > budget:
        return _unsat(
            "MAXIMUM_SPEND_EXCEEDED",
            details,
            requiredMinorUnits=authorized_total,
            maximumMinorUnits=budget,
        )
    preferred = [
        preference.account_id
        for preference in goal_contract.preferences
        if preference.type == "PREFER_ACCOUNT"
    ]
    eligible_accounts.sort(key=lambda account: (account.id not in preferred, account.id))
    funded_accounts = [
        candidate
        for candidate in eligible_accounts
        if int(candidate.available_minor_units) >= authorized_total
        and int(candidate.ledger_minor_units) >= authorized_total
    ]
    if not funded_accounts:
        return _unsat(
            "INSUFFICIENT_FUNDS",
            details,
            requiredMinorUnits=authorized_total,
            currency=quote.settlement_currency,
        )
    maximum_spend = budget if budget is not None else authorized_total
    first_violation = None
    for account in funded_accounts:
        operation = BuyAsset(
            source_account_id=account.id,
            asset_id=asset.id,
            quantity=quantity,
            quote_id=quote.quote_id,
            unit_price_minor=unit_price,
            price=Money(quote.settlement_currency, int(quoted_price)),
            fee=Money(quote.settlement_currency, fee),
            maximum_spend=Money(quote.settlement_currency, maximum_spend),
        )
        projected = SimulatedState.from_snapshot(snapshot)
        applied = apply_operation(projected, operation)
        if not applied.success:
            continue
        evaluation = evaluate_constraints(
            goal_contract, snapshot, applied.state, (operation,), hard_rules
        )
        if evaluation.valid:
            return operation
        if first_violation is None:
            first_violation = evaluation.violations[0]
    if first_violation is not None:
        return _unsat(first_violation.code, details, **first_violation.details)
    return _unsat("COMPOSITE_SIMULATION_FAILED", details)
