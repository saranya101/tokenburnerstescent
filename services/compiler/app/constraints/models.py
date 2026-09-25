"""Internal, immutable C2 decisions with canonical rule provenance."""

from dataclasses import dataclass, field
from typing import Any, Literal

RuleType = Literal[
    "MAX_TOTAL_COST",
    "MIN_AVAILABLE_BALANCE",
    "EXCLUDED_ACCOUNT",
    "MAX_LOCK_IN_DAYS",
    "MAX_SINGLE_TRANSACTION",
]
RuleSource = Literal["REQUEST", "PERSISTENT_USER_RULE"]


@dataclass(frozen=True)
class RuleOrigin:
    source: RuleSource
    rule_id: str


@dataclass(frozen=True)
class EffectiveRule:
    constraint_type: RuleType
    origins: tuple[RuleOrigin, ...]
    currency: str | None = None
    minor_units: int | None = None
    account_id: str | None = None
    days: int | None = None
    controlling_origin: RuleOrigin | None = None


@dataclass(frozen=True)
class EffectiveConstraintSet:
    rules: tuple[EffectiveRule, ...]


@dataclass(frozen=True)
class ConstraintViolation:
    code: str
    constraint_type: RuleType | str
    source: RuleSource | Literal["EVALUATION"]
    details: dict[str, Any] = field(default_factory=dict)
    origins: tuple[RuleOrigin, ...] = ()


@dataclass(frozen=True)
class ConstraintEvaluationResult:
    valid: bool
    violations: tuple[ConstraintViolation, ...]
    effective_rules: EffectiveConstraintSet
