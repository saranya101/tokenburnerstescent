"""Conservative request + enabled persistent-rule merge; never mutates wire inputs."""

from app.constraints.models import EffectiveConstraintSet, EffectiveRule, RuleOrigin
from app.models.contracts import GoalContractV1, HardRule

_RULE_ORDER = {
    "MAX_TOTAL_COST": 0,
    "MIN_AVAILABLE_BALANCE": 1,
    "EXCLUDED_ACCOUNT": 2,
    "MAX_LOCK_IN_DAYS": 3,
    "MAX_SINGLE_TRANSACTION": 4,
}


def merge_effective_rules(
    goal: GoalContractV1, hard_rules: tuple[HardRule, ...] = ()
) -> EffectiveConstraintSet:
    candidates: list[EffectiveRule] = []
    for index, constraint in enumerate(goal.constraints):
        origin = (RuleOrigin("REQUEST", f"{goal.id}:{goal.version}:{index}"),)
        if constraint.type in ("MAX_TOTAL_COST", "MIN_AVAILABLE_BALANCE"):
            candidates.append(
                EffectiveRule(
                    constraint.type,
                    origin,
                    constraint.money.currency,
                    int(constraint.money.minor_units),
                    getattr(constraint, "account_id", None),
                )
            )
        elif constraint.type == "EXCLUDED_ACCOUNT":
            candidates.append(
                EffectiveRule(constraint.type, origin, account_id=constraint.account_id)
            )
        else:
            candidates.append(EffectiveRule(constraint.type, origin, days=constraint.days))
    for hard_rule in hard_rules:
        if not hard_rule.enabled or hard_rule.user_id != goal.user_id:
            continue
        origin = (RuleOrigin("PERSISTENT_USER_RULE", hard_rule.id),)
        if hard_rule.type in ("MIN_AVAILABLE_BALANCE", "MAX_SINGLE_TRANSACTION"):
            candidates.append(
                EffectiveRule(
                    hard_rule.type,
                    origin,
                    hard_rule.money.currency,
                    int(hard_rule.money.minor_units),
                    getattr(hard_rule, "account_id", None),
                )
            )
        else:
            candidates.append(
                EffectiveRule("EXCLUDED_ACCOUNT", origin, account_id=hard_rule.account_id)
            )

    merged: dict[tuple[str, str | None, str | None], EffectiveRule] = {}
    for rule in candidates:
        key = (rule.constraint_type, rule.currency, rule.account_id)
        old = merged.get(key)
        if old is None:
            merged[key] = rule
            continue
        if rule.constraint_type in ("MIN_AVAILABLE_BALANCE",):
            stricter = max(old.minor_units, rule.minor_units)
            winners = (
                old if old.minor_units == stricter else None,
                rule if rule.minor_units == stricter else None,
            )
        elif rule.constraint_type in ("MAX_TOTAL_COST", "MAX_SINGLE_TRANSACTION"):
            stricter = min(old.minor_units, rule.minor_units)
            winners = (
                old if old.minor_units == stricter else None,
                rule if rule.minor_units == stricter else None,
            )
        elif rule.constraint_type == "MAX_LOCK_IN_DAYS":
            stricter = min(old.days, rule.days)
            winners = (
                old if old.days == stricter else None,
                rule if rule.days == stricter else None,
            )
        else:
            winners = (old, rule)
        winner = next(item for item in winners if item is not None)
        # Keep both inputs for audit, even when only one controls the threshold.
        origins = old.origins + rule.origins
        controlling_origin = winner.controlling_origin or winner.origins[0]
        merged[key] = EffectiveRule(
            winner.constraint_type,
            origins,
            winner.currency,
            winner.minor_units,
            winner.account_id,
            winner.days,
            controlling_origin,
        )
    return EffectiveConstraintSet(
        tuple(
            sorted(
                merged.values(),
                key=lambda rule: (
                    _RULE_ORDER[rule.constraint_type],
                    rule.currency or "",
                    rule.account_id or "",
                ),
            )
        )
    )
