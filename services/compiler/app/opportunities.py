"""C6 deterministic, informational opportunities; never creates an executable action."""

from dataclasses import dataclass
from datetime import datetime, timedelta
from decimal import ROUND_HALF_EVEN, Decimal, InvalidOperation
from typing import Literal

from app.constraints.effective_rules import merge_effective_rules
from app.constraints.liquidity import available_liquidity
from app.models.contracts import (
    BankStateSnapshotV1,
    GoalContractV1,
    HardRule,
    MinAvailableBalanceGroundedV1,
    MoneyV1,
)
from app.planner.compiler import compile_goal
from app.policy.engine import PolicyEngine
from app.policy.rules import account_restrictions
from app.relaxation import find_max_feasible_amount

DEFAULT_OPPORTUNITY_HORIZON_DAYS = 30
DEFAULT_OPPORTUNITY_TTL_MINUTES = 60
_TYPE_ORDER = (
    "AVAILABLE_ABOVE_RESERVE",
    "AVAILABLE_AFTER_OBLIGATIONS",
    "GOAL_AMOUNT_FEASIBILITY",
    "EMERGENCY_RESERVE_GAP",
    "UPCOMING_OBLIGATION_COVERAGE",
)


@dataclass(frozen=True)
class OpportunityCandidate:
    type: str
    state_version: int
    currency: str
    amount_minor_units: str | None
    status: str
    facts: tuple[tuple[str, str], ...]
    constraints_applied: tuple[str, ...]
    expires_at: datetime
    feasibility_proven: bool = False


@dataclass(frozen=True)
class OpportunityDiagnostics:
    opportunity_templates_evaluated: int
    compiler_calls: int
    feasibility_search_iterations: int
    obligations_considered: int
    accounts_considered: int
    candidates_produced: int
    candidates_rejected: int
    rejection_reasons: tuple[str, ...]


@dataclass(frozen=True)
class OpportunityResult:
    candidates: tuple[OpportunityCandidate, ...]
    diagnostics: OpportunityDiagnostics


@dataclass(frozen=True)
class LiquidityFact:
    status: Literal["READY", "CANNOT_PROVE_SAFE"]
    currency: str
    available_minor_units: int
    safe_minor_units: int
    global_reserve_minor_units: int
    account_reserve_minor_units: int
    accounts_considered: int
    constraints_applied: tuple[str, ...]
    reason: str | None = None


@dataclass(frozen=True)
class ObligationFact:
    status: Literal["READY", "CANNOT_PROVE_SAFE"]
    currency: str
    amount_minor_units: int
    count: int
    earliest_due_at: datetime | None
    horizon_days: int
    reason: str | None = None


def _rules(snapshot: BankStateSnapshotV1, hard_rules: tuple[HardRule, ...]):
    if any(rule.enabled and rule.user_id != snapshot.user_id for rule in hard_rules):
        return None
    return merge_effective_rules(None, hard_rules, user_id=snapshot.user_id).rules


def _facts(**values: object) -> tuple[tuple[str, str], ...]:
    return tuple(sorted((key, str(value)) for key, value in values.items()))


def available_above_reserve(
    snapshot: BankStateSnapshotV1,
    hard_rules: tuple[HardRule, ...],
    currency: str,
    policy: PolicyEngine | None = None,
) -> LiquidityFact:
    rules = _rules(snapshot, hard_rules)
    empty = LiquidityFact("CANNOT_PROVE_SAFE", currency, 0, 0, 0, 0, 0, ())
    if rules is None:
        return LiquidityFact(**{**empty.__dict__, "reason": "HARD_RULE_USER_MISMATCH"})
    policy = policy or PolicyEngine()
    if not snapshot.service_availability.transfers or not (
        {"TRANSFER", "MOVE_FUNDS"} & policy.allowed_operations
    ):
        return LiquidityFact(**{**empty.__dict__, "reason": "REQUIRED_SERVICE_UNAVAILABLE"})
    if len({account.id for account in snapshot.accounts}) != len(snapshot.accounts):
        return LiquidityFact(**{**empty.__dict__, "reason": "DUPLICATE_ACCOUNT_ID"})
    try:
        if any(
            int(account.available_minor_units) < 0 or int(account.ledger_minor_units) < 0
            for account in snapshot.accounts
            if account.currency == currency
        ):
            return LiquidityFact(**{**empty.__dict__, "reason": "INVALID_ACCOUNT_BALANCE"})
    except ValueError:
        return LiquidityFact(**{**empty.__dict__, "reason": "INVALID_ACCOUNT_BALANCE"})
    excluded = {rule.account_id for rule in rules if rule.constraint_type == "EXCLUDED_ACCOUNT"}
    reserve_rules = [
        rule
        for rule in rules
        if rule.constraint_type == "MIN_AVAILABLE_BALANCE" and rule.currency == currency
    ]
    global_reserve = max(
        (rule.minor_units for rule in reserve_rules if rule.account_id is None), default=0
    )
    per_account = {
        rule.account_id: rule.minor_units for rule in reserve_rules if rule.account_id is not None
    }
    eligible = [
        account
        for account in snapshot.accounts
        if account.currency == currency
        and account.id not in excluded
        and not account_restrictions(account, "SEND_TRANSFER")
    ]
    balances = {
        account.id: min(
            available_liquidity(snapshot, currency, account.id), int(account.ledger_minor_units)
        )
        for account in eligible
    }
    available = sum(balances.values())
    after_specific = sum(
        max(0, balance - per_account.get(account_id, 0)) for account_id, balance in balances.items()
    )
    global_liquidity = available_liquidity(snapshot, currency)
    global_headroom = max(0, global_liquidity - global_reserve)
    safe = min(after_specific, global_headroom)
    applied = tuple(
        sorted(
            rule.controlling_origin.rule_id if rule.controlling_origin else rule.origins[0].rule_id
            for rule in rules
            if rule.constraint_type in {"MIN_AVAILABLE_BALANCE", "EXCLUDED_ACCOUNT"}
            and (rule.currency in (None, currency))
        )
    )
    return LiquidityFact(
        "READY",
        currency,
        available,
        safe,
        global_reserve,
        sum(per_account.values()),
        len(eligible),
        applied,
    )


def _obligations(
    snapshot: BankStateSnapshotV1,
    currency: str,
    horizon_days: int,
) -> ObligationFact:
    if horizon_days < 0:
        raise ValueError("horizon_days must be nonnegative")
    relevant = [
        item
        for item in snapshot.obligations
        if item.status in {"OPEN", "OVERDUE"}
        and item.due_at <= snapshot.captured_at + timedelta(days=horizon_days)
    ]
    if len({item.id for item in relevant}) != len(relevant):
        return ObligationFact(
            "CANNOT_PROVE_SAFE",
            currency,
            0,
            len(relevant),
            None,
            horizon_days,
            "DUPLICATE_OBLIGATION_ID",
        )
    if any(item.money.currency != currency for item in relevant):
        return ObligationFact(
            "CANNOT_PROVE_SAFE",
            currency,
            0,
            len(relevant),
            None,
            horizon_days,
            "MIXED_CURRENCY_OBLIGATIONS",
        )
    try:
        invalid_amount = any(int(item.money.minor_units) < 0 for item in relevant)
    except ValueError:
        invalid_amount = True
    if invalid_amount:
        return ObligationFact(
            "CANNOT_PROVE_SAFE",
            currency,
            0,
            len(relevant),
            None,
            horizon_days,
            "INVALID_OBLIGATION_AMOUNT",
        )
    return ObligationFact(
        "READY",
        currency,
        sum(int(item.money.minor_units) for item in relevant),
        len(relevant),
        min((item.due_at for item in relevant), default=None),
        horizon_days,
    )


def available_after_obligations(
    snapshot: BankStateSnapshotV1,
    hard_rules: tuple[HardRule, ...],
    currency: str,
    horizon_days: int = DEFAULT_OPPORTUNITY_HORIZON_DAYS,
    policy: PolicyEngine | None = None,
) -> tuple[LiquidityFact, ObligationFact, int | None]:
    liquidity = available_above_reserve(snapshot, hard_rules, currency, policy)
    obligations = _obligations(snapshot, currency, horizon_days)
    if liquidity.status != "READY" or obligations.status != "READY":
        return liquidity, obligations, None
    return (
        liquidity,
        obligations,
        max(0, liquidity.safe_minor_units - obligations.amount_minor_units),
    )


def _candidate(
    kind: str,
    snapshot: BankStateSnapshotV1,
    currency: str,
    amount: int | None,
    status: str,
    facts: tuple[tuple[str, str], ...],
    applied: tuple[str, ...],
    expiry: datetime,
    proven: bool = False,
) -> OpportunityCandidate:
    return OpportunityCandidate(
        kind,
        snapshot.state_version,
        currency,
        str(amount) if amount is not None else None,
        status,
        facts,
        applied,
        expiry,
        proven,
    )


def _goal_upper_bound(
    snapshot: BankStateSnapshotV1,
    currency: str,
    excluded: set[str],
) -> int | None:
    """Overbound supported direct and one-quote FX funding using trusted rates."""
    upper = 0
    for account in snapshot.accounts:
        if account.id in excluded or account.status != "ACTIVE":
            continue
        try:
            funds = min(
                available_liquidity(snapshot, account.currency, account.id),
                int(account.ledger_minor_units),
            )
        except ValueError:
            return None
        if funds < 0:
            return None
        if account.currency == currency and "SEND_TRANSFER" in account.capabilities:
            upper += funds
        elif (
            account.currency != currency
            and ("CONVERT_FX" in account.capabilities or "SEND_TRANSFER" in account.capabilities)
            and any(
                other.currency == account.currency
                and other.status == "ACTIVE"
                and "CONVERT_FX" in other.capabilities
                and (other.id == account.id or "RECEIVE_TRANSFER" in other.capabilities)
                for other in snapshot.accounts
            )
        ):
            outputs = []
            for quote in snapshot.fx_quotes:
                if (
                    quote.from_currency != account.currency
                    or quote.to_currency != currency
                    or quote.expires_at <= snapshot.captured_at
                ):
                    continue
                try:
                    rate = Decimal(quote.rate)
                    if rate.is_finite() and rate > 0:
                        outputs.append(
                            int(
                                (Decimal(funds) * rate).quantize(
                                    Decimal("1"), rounding=ROUND_HALF_EVEN
                                )
                            )
                        )
                except InvalidOperation:
                    continue
            upper += max(outputs, default=0)
    return upper


def discover_opportunities(
    snapshot: BankStateSnapshotV1,
    hard_rules: tuple[HardRule, ...] = (),
    policy: PolicyEngine | None = None,
    goal_templates: tuple[GoalContractV1, ...] = (),
    template_types: tuple[str, ...] = _TYPE_ORDER,
    horizon_days: int = DEFAULT_OPPORTUNITY_HORIZON_DAYS,
    ttl_minutes: int = DEFAULT_OPPORTUNITY_TTL_MINUTES,
    max_depth: int = 4,
    max_states: int = 1000,
) -> OpportunityResult:
    if horizon_days < 0 or ttl_minutes <= 0:
        raise ValueError("horizon and TTL must be positive")
    expiry = snapshot.captured_at + timedelta(minutes=ttl_minutes)
    policy = policy or PolicyEngine()
    candidates: list[OpportunityCandidate] = []
    rejections: list[str] = []
    compiler_calls = iterations = obligations_count = accounts_count = evaluated = 0
    currencies = sorted(
        {account.currency for account in snapshot.accounts}
        | {item.money.currency for item in snapshot.obligations}
    )
    for currency in currencies:
        liquidity = available_above_reserve(snapshot, hard_rules, currency, policy)
        obligations = _obligations(snapshot, currency, horizon_days)
        obligation_expiry = expiry
        if (
            obligations.earliest_due_at is not None
            and obligations.earliest_due_at > snapshot.captured_at
        ):
            obligation_expiry = min(expiry, obligations.earliest_due_at)
        matching_templates = [
            goal
            for goal in goal_templates
            if goal.goal.type in {"DELIVER_MONEY", "MOVE_FUNDS"}
            and goal.goal.amount.currency == currency
            and goal.user_id == snapshot.user_id
        ]

        def prove_fact_amount(
            amount: int,
            with_obligations: bool,
            templates=matching_templates,
            obligation_fact=obligations,
            currency_code=currency,
            liquidity_fact=liquidity,
        ) -> bool | None:
            nonlocal compiler_calls
            if amount <= 0 or len(templates) != 1:
                return None
            probe = templates[0].model_copy(deep=True)
            probe.goal.amount.minor_units = str(amount)
            if with_obligations and obligation_fact.amount_minor_units:
                probe.constraints.append(
                    MinAvailableBalanceGroundedV1(
                        type="MIN_AVAILABLE_BALANCE",
                        money=MoneyV1(
                            currency=currency_code,
                            minorUnits=str(
                                liquidity_fact.global_reserve_minor_units
                                + obligation_fact.amount_minor_units
                            ),
                        ),
                    )
                )
            compiler_calls += 1
            return (
                compile_goal(probe, snapshot, hard_rules, policy, max_depth, max_states).status
                == "SAT"
            )

        accounts_count += liquidity.accounts_considered
        obligations_count += obligations.count
        for kind in _TYPE_ORDER:
            if kind not in template_types:
                continue
            evaluated += 1
            if kind in {
                "AVAILABLE_ABOVE_RESERVE",
                "AVAILABLE_AFTER_OBLIGATIONS",
                "UPCOMING_OBLIGATION_COVERAGE",
                "GOAL_AMOUNT_FEASIBILITY",
                "EMERGENCY_RESERVE_GAP",
            }:
                if liquidity.status != "READY":
                    rejections.append(liquidity.reason or "LIQUIDITY_UNPROVEN")
                    continue
            if (
                kind
                in {
                    "AVAILABLE_AFTER_OBLIGATIONS",
                    "UPCOMING_OBLIGATION_COVERAGE",
                    "GOAL_AMOUNT_FEASIBILITY",
                }
                and obligations.status != "READY"
            ):
                rejections.append(obligations.reason or "OBLIGATIONS_UNPROVEN")
                continue
            if kind == "AVAILABLE_ABOVE_RESERVE":
                proven = prove_fact_amount(liquidity.safe_minor_units, False)
                if proven is False:
                    rejections.append("ACCOUNTING_AMOUNT_NOT_COMPILER_FEASIBLE")
                    continue
                candidates.append(
                    _candidate(
                        kind,
                        snapshot,
                        currency,
                        liquidity.safe_minor_units,
                        "FACT",
                        _facts(
                            availableLiquidityMinorUnits=liquidity.available_minor_units,
                            globalReserveMinorUnits=liquidity.global_reserve_minor_units,
                            accountReserveMinorUnits=liquidity.account_reserve_minor_units,
                        ),
                        liquidity.constraints_applied,
                        expiry,
                        proven is True,
                    )
                )
            elif kind == "AVAILABLE_AFTER_OBLIGATIONS":
                amount = max(0, liquidity.safe_minor_units - obligations.amount_minor_units)
                proven = prove_fact_amount(amount, True)
                if proven is False:
                    rejections.append("ACCOUNTING_AMOUNT_NOT_COMPILER_FEASIBLE")
                    continue
                candidates.append(
                    _candidate(
                        kind,
                        snapshot,
                        currency,
                        amount,
                        "FACT",
                        _facts(
                            availableAboveReserveMinorUnits=liquidity.safe_minor_units,
                            upcomingObligationsMinorUnits=obligations.amount_minor_units,
                            horizonDays=horizon_days,
                        ),
                        liquidity.constraints_applied,
                        obligation_expiry,
                        proven is True,
                    )
                )
            elif kind == "EMERGENCY_RESERVE_GAP":
                rules = _rules(snapshot, hard_rules)
                reserves = [
                    rule
                    for rule in rules or ()
                    if rule.constraint_type == "MIN_AVAILABLE_BALANCE" and rule.currency == currency
                ]
                if not reserves:
                    continue
                gaps = []
                for rule in reserves:
                    actual = available_liquidity(snapshot, currency, rule.account_id)
                    gaps.append(max(0, rule.minor_units - actual))
                gap = max(gaps, default=0)
                candidates.append(
                    _candidate(
                        kind,
                        snapshot,
                        currency,
                        gap,
                        "RESERVE_SHORTFALL" if gap else "RESERVE_FULLY_FUNDED",
                        _facts(reserveShortfallMinorUnits=gap, reserveRuleCount=len(reserves)),
                        liquidity.constraints_applied,
                        expiry,
                    )
                )
            elif kind == "UPCOMING_OBLIGATION_COVERAGE":
                if obligations.count == 0:
                    continue
                shortfall = max(0, obligations.amount_minor_units - liquidity.safe_minor_units)
                covered = min(obligations.amount_minor_units, liquidity.safe_minor_units)
                status = (
                    "FULLY_COVERED"
                    if shortfall == 0
                    else "NOT_COVERED"
                    if covered == 0
                    else "PARTIALLY_COVERED"
                )
                candidates.append(
                    _candidate(
                        kind,
                        snapshot,
                        currency,
                        covered,
                        status,
                        _facts(
                            totalObligationsMinorUnits=obligations.amount_minor_units,
                            protectedLiquidityMinorUnits=liquidity.safe_minor_units,
                            shortfallMinorUnits=shortfall,
                            earliestDueAt=obligations.earliest_due_at.isoformat()
                            if obligations.earliest_due_at
                            else "",
                            horizonDays=horizon_days,
                        ),
                        liquidity.constraints_applied,
                        obligation_expiry,
                    )
                )
            elif kind == "GOAL_AMOUNT_FEASIBILITY":
                if len(matching_templates) != 1:
                    rejections.append("GROUNDED_TEMPLATE_REQUIRED")
                    continue
                if len({quote.id for quote in snapshot.fx_quotes}) != len(snapshot.fx_quotes):
                    rejections.append("DUPLICATE_QUOTE_ID")
                    continue
                template = matching_templates[0].model_copy(deep=True)
                # Reserve known obligations as an internal request-level floor.
                if obligations.amount_minor_units:
                    template.constraints.append(
                        MinAvailableBalanceGroundedV1(
                            type="MIN_AVAILABLE_BALANCE",
                            money=MoneyV1(
                                currency=currency,
                                minorUnits=str(
                                    liquidity.global_reserve_minor_units
                                    + obligations.amount_minor_units
                                ),
                            ),
                        )
                    )
                rules = _rules(snapshot, hard_rules)
                excluded = {
                    rule.account_id
                    for rule in rules or ()
                    if rule.constraint_type == "EXCLUDED_ACCOUNT"
                }
                upper = _goal_upper_bound(snapshot, currency, excluded)
                if upper is None:
                    rejections.append("FUNDING_BOUND_UNPROVEN")
                    continue
                bound = find_max_feasible_amount(
                    template, snapshot, upper, hard_rules, policy, max_depth, max_states
                )
                compiler_calls += bound.diagnostics.compiler_calls
                iterations += bound.diagnostics.relaxation_iterations
                if bound.status not in {"FEASIBLE", "ZERO_FEASIBLE"}:
                    rejections.append(bound.reason.code if bound.reason else "FEASIBILITY_UNPROVEN")
                    continue
                maximum = (
                    int(bound.maximum_feasible_amount.minor_units)
                    if bound.maximum_feasible_amount
                    else 0
                )
                candidate_expiry = obligation_expiry
                if maximum > 0:
                    proof = template.model_copy(deep=True)
                    proof.goal.amount.minor_units = str(maximum)
                    check = compile_goal(proof, snapshot, hard_rules, policy, max_depth, max_states)
                    compiler_calls += 1
                    above = template.model_copy(deep=True)
                    above.goal.amount.minor_units = str(maximum + 1)
                    boundary = compile_goal(
                        above, snapshot, hard_rules, policy, max_depth, max_states
                    )
                    compiler_calls += 1
                    if (
                        check.status != "SAT"
                        or boundary.status != "UNSAT"
                        or boundary.reason.code
                        in {
                            "MAX_STATES_EXPLORED",
                            "SEARCH_DEPTH_EXHAUSTED",
                            "AMBIGUOUS_VALID_PLANS",
                            "COST_COMPARISON_UNAVAILABLE",
                        }
                    ):
                        rejections.append("EXACT_MAXIMUM_UNPROVEN")
                        continue
                    if check.plan.validity.valid_until is not None:
                        candidate_expiry = min(candidate_expiry, check.plan.validity.valid_until)
                candidates.append(
                    _candidate(
                        kind,
                        snapshot,
                        currency,
                        maximum,
                        "FEASIBLE" if maximum else "ZERO_FEASIBLE",
                        _facts(
                            maximumFeasibleMinorUnits=maximum,
                            horizonDays=horizon_days,
                            groundedGoalContractId=template.id,
                            upcomingObligationsMinorUnits=obligations.amount_minor_units,
                        ),
                        tuple(
                            sorted(
                                [rule.id for rule in hard_rules if rule.enabled]
                                + (
                                    ["OPPORTUNITY_OBLIGATION_RESERVE"]
                                    if obligations.amount_minor_units
                                    else []
                                )
                            )
                        ),
                        candidate_expiry,
                        True,
                    )
                )
    # An informational type/currency/state has one deterministic answer.
    unique = {(item.type, item.currency, item.state_version): item for item in candidates}
    ordered = tuple(
        unique[key]
        for key in sorted(unique, key=lambda key: (_TYPE_ORDER.index(key[0]), key[1], key[2]))
    )
    return OpportunityResult(
        ordered,
        OpportunityDiagnostics(
            evaluated,
            compiler_calls,
            iterations,
            obligations_count,
            accounts_count,
            len(ordered),
            len(rejections),
            tuple(sorted(rejections)),
        ),
    )
