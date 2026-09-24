"""Evaluate approved customer requirements against supplied candidate state/actions."""

from dataclasses import dataclass

from app.constraints.cost import account_costs_for_limit, operation_amount
from app.constraints.effective_rules import merge_effective_rules
from app.constraints.liquidity import available_liquidity
from app.constraints.models import ConstraintEvaluationResult, ConstraintViolation, EffectiveRule
from app.models.contracts import BankStateSnapshotV1, GoalContractV1, HardRule
from app.operations.models import BuyAsset, InternalOperation
from app.simulator.state import SimulatedState


@dataclass(frozen=True)
class CandidateOperation:
    operation: InternalOperation
    # A product-specific duration supplied by a trusted deterministic adapter.
    lock_in_days: int | None = None


def _source_account(operation: InternalOperation) -> str | None:
    return getattr(operation, "source_account_id", None)


def _violation(code: str, rule: EffectiveRule, **details: object) -> ConstraintViolation:
    return ConstraintViolation(
        code,
        rule.constraint_type,
        (rule.controlling_origin or rule.origins[0]).source,
        details,
        rule.origins,
    )


def evaluate_constraints(
    goal_contract: GoalContractV1,
    initial_state: BankStateSnapshotV1,
    current_or_projected_state: BankStateSnapshotV1 | SimulatedState,
    candidate_operations: tuple[InternalOperation | CandidateOperation, ...] = (),
    hard_rules: tuple[HardRule, ...] = (),
) -> ConstraintEvaluationResult:
    """No simulation or route generation occurs; caller supplies the projected state."""
    effective = merge_effective_rules(goal_contract, hard_rules)
    candidates = tuple(
        item if isinstance(item, CandidateOperation) else CandidateOperation(item)
        for item in candidate_operations
    )
    operations = tuple(item.operation for item in candidates)
    errors: list[ConstraintViolation] = []
    projected_snapshot = (
        current_or_projected_state.to_snapshot()
        if isinstance(current_or_projected_state, SimulatedState)
        else current_or_projected_state
    )
    for role, state in (("initial", initial_state), ("projected", projected_snapshot)):
        if state.user_id != goal_contract.user_id:
            errors.append(
                ConstraintViolation(
                    "STATE_USER_MISMATCH",
                    "STATE_IDENTITY",
                    "EVALUATION",
                    {
                        "role": role,
                        "stateUserId": state.user_id,
                        "goalUserId": goal_contract.user_id,
                    },
                )
            )
    for hard_rule in hard_rules:
        if hard_rule.enabled and hard_rule.user_id != goal_contract.user_id:
            errors.append(
                ConstraintViolation(
                    "HARD_RULE_USER_MISMATCH",
                    hard_rule.type,
                    "EVALUATION",
                    {
                        "ruleId": hard_rule.id,
                        "goalUserId": goal_contract.user_id,
                        "ruleUserId": hard_rule.user_id,
                    },
                )
            )

    for rule in effective.rules:
        if rule.constraint_type == "MAX_TOTAL_COST":
            costs = account_costs_for_limit(initial_state, operations, rule.currency)
            for index in costs.invalid_operations:
                errors.append(_violation("COST_INPUT_INVALID", rule, operationIndex=index))
            for quote_id in costs.missing_quote_ids:
                errors.append(_violation("COST_UNAVAILABLE", rule, quoteId=quote_id))
            for currency in costs.foreign_currencies(rule.currency):
                errors.append(
                    _violation(
                        "COST_CURRENCY_MISMATCH",
                        rule,
                        costCurrency=currency,
                        limitCurrency=rule.currency,
                    )
                )
            if (
                not costs.invalid_operations
                and not costs.missing_quote_ids
                and not costs.foreign_currencies(rule.currency)
            ):
                total = costs.total(rule.currency)
                if total > rule.minor_units:
                    errors.append(
                        _violation(
                            "MAX_TOTAL_COST_VIOLATED",
                            rule,
                            currency=rule.currency,
                            maximumMinorUnits=str(rule.minor_units),
                            projectedMinorUnits=str(total),
                        )
                    )
        elif rule.constraint_type == "MIN_AVAILABLE_BALANCE":
            projected = available_liquidity(
                current_or_projected_state, rule.currency, rule.account_id
            )
            if projected < rule.minor_units:
                errors.append(
                    _violation(
                        "MIN_AVAILABLE_BALANCE_VIOLATED",
                        rule,
                        currency=rule.currency,
                        accountId=rule.account_id,
                        requiredMinorUnits=str(rule.minor_units),
                        projectedMinorUnits=str(projected),
                    )
                )
        elif rule.constraint_type == "EXCLUDED_ACCOUNT":
            for index, candidate in enumerate(candidates):
                if _source_account(candidate.operation) == rule.account_id:
                    errors.append(
                        _violation(
                            "EXCLUDED_ACCOUNT_USED",
                            rule,
                            accountId=rule.account_id,
                            operationIndex=index,
                            action=candidate.operation.action,
                        )
                    )
        elif rule.constraint_type == "MAX_LOCK_IN_DAYS":
            for index, candidate in enumerate(candidates):
                days = candidate.lock_in_days
                if days is None and not isinstance(candidate.operation, BuyAsset):
                    days = 0  # Existing non-buy operations do not create a lock-in product.
                if days is None or days < 0:
                    errors.append(
                        _violation(
                            "LOCK_IN_DURATION_UNKNOWN",
                            rule,
                            operationIndex=index,
                            action=candidate.operation.action,
                        )
                    )
                elif days > rule.days:
                    errors.append(
                        _violation(
                            "MAX_LOCK_IN_DAYS_VIOLATED",
                            rule,
                            operationIndex=index,
                            action=candidate.operation.action,
                            maximumDays=rule.days,
                            projectedDays=days,
                        )
                    )
        elif rule.constraint_type == "MAX_SINGLE_TRANSACTION":
            for index, candidate in enumerate(candidates):
                currency, amount = operation_amount(candidate.operation)
                if amount <= 0:
                    errors.append(
                        _violation(
                            "INVALID_TRANSACTION_AMOUNT",
                            rule,
                            operationIndex=index,
                            action=candidate.operation.action,
                        )
                    )
                elif currency != rule.currency:
                    errors.append(
                        _violation(
                            "TRANSACTION_CURRENCY_MISMATCH",
                            rule,
                            operationIndex=index,
                            action=candidate.operation.action,
                            transactionCurrency=currency,
                            limitCurrency=rule.currency,
                        )
                    )
                elif currency == rule.currency and amount > rule.minor_units:
                    errors.append(
                        _violation(
                            "MAX_SINGLE_TRANSACTION_VIOLATED",
                            rule,
                            operationIndex=index,
                            action=candidate.operation.action,
                            currency=currency,
                            maximumMinorUnits=str(rule.minor_units),
                            transactionMinorUnits=str(amount),
                        )
                    )
    return ConstraintEvaluationResult(not errors, tuple(errors), effective)
