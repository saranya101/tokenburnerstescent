"""Shared bank permission facts used by C1 local validity and C2 policy."""

from app.models.contracts import AccountV1, AssetV1, BankStateSnapshotV1, BeneficiaryV1


def account_restrictions(account: AccountV1, capability: str | None = None) -> tuple[str, ...]:
    issues: list[str] = []
    if account.status == "FROZEN":
        issues.append("ACCOUNT_FROZEN")
    elif account.status != "ACTIVE":
        issues.append("ACCOUNT_INACTIVE")
    if capability is not None and capability not in account.capabilities:
        issues.append("ACCOUNT_CAPABILITY_MISSING")
    return tuple(issues)


def beneficiary_restriction(beneficiary: BeneficiaryV1) -> str | None:
    if beneficiary.status == "BLOCKED":
        return "BENEFICIARY_BLOCKED"
    if beneficiary.status != "ACTIVE":
        return "BENEFICIARY_UNVERIFIED"
    return None


def asset_restriction(asset: AssetV1) -> str | None:
    return "ASSET_NOT_TRADABLE" if not asset.tradable else None


def service_available(snapshot: BankStateSnapshotV1, service: str) -> bool:
    attribute = "bill_payments" if service == "billPayments" else service
    return bool(getattr(snapshot.service_availability, attribute))
