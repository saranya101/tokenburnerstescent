"""Bank permission checks. Local financial validity remains with C1 operations."""

from dataclasses import dataclass, field
from typing import Any

from app.models.contracts import BankStateSnapshotV1
from app.operations.library import OPERATION_LIBRARY
from app.operations.models import (
    BuyAsset,
    FxConvert,
    InternalOperation,
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
class PolicyViolation:
    code: str
    rule_type: str
    source: str = "BANK_POLICY"
    details: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class PolicyEvaluationResult:
    allowed: bool
    violations: tuple[PolicyViolation, ...]


class PolicyEngine:
    def __init__(self, allowed_operations: frozenset[str] | None = None):
        self.allowed_operations = (
            allowed_operations if allowed_operations is not None else frozenset(OPERATION_LIBRARY)
        )

    def evaluate(
        self, state: BankStateSnapshotV1 | SimulatedState, operation: InternalOperation
    ) -> PolicyEvaluationResult:
        snapshot = state.to_snapshot() if isinstance(state, SimulatedState) else state
        errors: list[PolicyViolation] = []

        def add(code: str, rule_type: str, **details: Any):
            errors.append(PolicyViolation(code, rule_type, details=details))

        if operation.action not in self.allowed_operations:
            add("OPERATION_NOT_ALLOWED", "OPERATION_ALLOWLIST", action=operation.action)
        service = OPERATION_LIBRARY[operation.action].availability
        if not service_available(snapshot, service):
            add("SERVICE_UNAVAILABLE", "SERVICE_AVAILABILITY", service=service)

        account_roles: list[tuple[str, str]] = []
        if isinstance(operation, (Transfer, MoveFunds)):
            account_roles.append((operation.source_account_id, "SEND_TRANSFER"))
        elif isinstance(operation, FxConvert):
            account_roles.append((operation.source_account_id, "CONVERT_FX"))
        elif isinstance(operation, PayBill):
            account_roles.append((operation.source_account_id, "PAY_BILL"))
        elif isinstance(operation, BuyAsset):
            account_roles.append((operation.source_account_id, "TRADE_ASSET"))
        elif isinstance(operation, SellAsset):
            account_roles.append((operation.destination_account_id, "TRADE_ASSET"))
        if isinstance(operation, (MoveFunds, FxConvert)):
            account_roles.append((operation.destination_account_id, "RECEIVE_TRANSFER"))

        for account_id, capability in account_roles:
            account = next((item for item in snapshot.accounts if item.id == account_id), None)
            if account is None:
                continue  # C1 reports ACCOUNT_NOT_FOUND, a local validity failure.
            for issue in account_restrictions(account, capability):
                if issue == "ACCOUNT_CAPABILITY_MISSING":
                    add(issue, "ACCOUNT_CAPABILITY", accountId=account_id, capability=capability)
                else:
                    add(issue, "ACCOUNT_STATUS", accountId=account_id, status=account.status)

        if isinstance(operation, Transfer):
            beneficiary = next(
                (item for item in snapshot.beneficiaries if item.id == operation.beneficiary_id),
                None,
            )
            if beneficiary is not None:
                restriction = beneficiary_restriction(beneficiary)
                if restriction:
                    add(
                        restriction,
                        "BENEFICIARY_STATUS",
                        beneficiaryId=beneficiary.id,
                        status=beneficiary.status,
                    )
        if isinstance(operation, (BuyAsset, SellAsset)):
            asset = next((item for item in snapshot.assets if item.id == operation.asset_id), None)
            if asset is not None and asset_restriction(asset):
                add("ASSET_NOT_TRADABLE", "ASSET_PERMISSION", assetId=asset.id)
        return PolicyEvaluationResult(not errors, tuple(errors))
