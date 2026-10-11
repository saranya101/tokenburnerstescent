"""Shared deterministic planning for a grounded asset acquisition."""

from decimal import ROUND_HALF_EVEN, Decimal, InvalidOperation

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
from app.operations.models import BuyAsset, FxConvert, InternalOperation, Money
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


def _funds(account) -> int:
    return min(int(account.available_minor_units), int(account.ledger_minor_units))


def _converted(amount: int, rate: Decimal) -> int:
    return int((Decimal(amount) * rate).quantize(Decimal("1"), rounding=ROUND_HALF_EVEN))


def _source_needed(target_minor_units: int, rate: Decimal) -> int:
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


def compile_acquire_route(
    goal_contract: GoalContractV1,
    snapshot: BankStateSnapshotV1,
    policy: PolicyEngine,
    hard_rules: tuple[HardRule, ...] = (),
) -> tuple[InternalOperation, ...] | CompilerUnsatV1 | CompilerPolicyBlockedV1:
    """Compile a direct purchase or an explicitly permitted FX-funded purchase.

    A non-settlement PREFER_ACCOUNT is the confirmed, plan-bound customer choice
    that permits using that account for funding. Without it, insufficient settled
    funds remain a controlled failure and no FX route is synthesized.
    """
    context: dict[str, object] = {"bankStateVersion": snapshot.state_version}
    direct = compile_acquire_operation(goal_contract, snapshot, policy, hard_rules, context=context)
    if isinstance(direct, BuyAsset):
        return (direct,)
    if direct.reason.code != "INSUFFICIENT_FUNDS":
        return direct
    if "FX_CONVERT" not in policy.allowed_operations:
        return direct
    if not snapshot.service_availability.fx:
        return _blocked("REQUIRED_SERVICE_UNAVAILABLE", context, service="fx")

    goal = goal_contract.goal
    assert isinstance(goal, AcquireAssetGroundedGoalV1)
    asset = next(item for item in snapshot.assets if item.id == goal.asset_id)
    required = int((direct.reason.details or {}).get("requiredMinorUnits", 0))
    preferred_ids = {
        preference.account_id
        for preference in goal_contract.preferences
        if preference.type == "PREFER_ACCOUNT"
    }
    sources = sorted(
        (
            account
            for account in snapshot.accounts
            if account.id in preferred_ids
            and account.status == "ACTIVE"
            and account.currency != asset.settlement_currency
            and "CONVERT_FX" in account.capabilities
        ),
        key=lambda account: account.id,
    )
    if not sources:
        return direct
    destinations = sorted(
        (
            account
            for account in snapshot.accounts
            if account.status == "ACTIVE"
            and account.currency == asset.settlement_currency
            and "TRADE_ASSET" in account.capabilities
            and "RECEIVE_TRANSFER" in account.capabilities
        ),
        key=lambda account: account.id,
    )
    saw_pair = False
    saw_expired = False
    saw_valid_quote = False
    saw_insufficient_source = False
    first_failure: CompilerUnsatV1 | CompilerPolicyBlockedV1 | None = None

    for destination in destinations:
        shortfall = required - _funds(destination)
        if shortfall <= 0:
            continue
        for source in sources:
            matching_quotes = sorted(
                (
                    quote
                    for quote in snapshot.fx_quotes
                    if quote.from_currency == source.currency
                    and quote.to_currency == asset.settlement_currency
                ),
                key=lambda quote: quote.id,
            )
            for quote in matching_quotes:
                saw_pair = True
                if quote.expires_at <= snapshot.captured_at:
                    saw_expired = True
                    continue
                try:
                    rate = Decimal(quote.rate)
                except InvalidOperation:
                    continue
                if not rate.is_finite() or rate <= 0:
                    continue
                if quote.fee is not None and quote.fee.currency != source.currency:
                    continue
                saw_valid_quote = True
                source_amount = _source_needed(shortfall, rate)
                fee = int(quote.fee.minor_units) if quote.fee is not None else 0
                if _funds(source) < source_amount + fee:
                    saw_insufficient_source = True
                    continue
                fx = FxConvert(
                    source.id,
                    destination.id,
                    Money(source.currency, source_amount),
                    asset.settlement_currency,
                    quote.id,
                )
                after_fx = apply_operation(SimulatedState.from_snapshot(snapshot), fx)
                if not after_fx.success:
                    continue
                purchase = compile_acquire_operation(
                    goal_contract,
                    after_fx.state.to_snapshot(),
                    policy,
                    hard_rules,
                    context=context,
                )
                if not isinstance(purchase, BuyAsset):
                    if first_failure is None:
                        first_failure = purchase
                    continue
                after_purchase = apply_operation(after_fx.state, purchase)
                if not after_purchase.success:
                    continue
                evaluation = evaluate_constraints(
                    goal_contract,
                    snapshot,
                    after_purchase.state,
                    (fx, purchase),
                    hard_rules,
                )
                if evaluation.valid:
                    return (fx, purchase)
                if first_failure is None:
                    violation = evaluation.violations[0]
                    first_failure = _unsat(violation.code, context, **violation.details)

    if first_failure is not None:
        return first_failure
    if saw_pair and not saw_valid_quote and saw_expired:
        return _unsat("QUOTE_EXPIRED", context, currency=asset.settlement_currency)
    if saw_insufficient_source:
        return _unsat(
            "INSUFFICIENT_FUNDING_FUNDS",
            context,
            fundingAccountIds=[source.id for source in sources],
        )
    return _unsat("NO_FX_ROUTE", context, currency=asset.settlement_currency)
