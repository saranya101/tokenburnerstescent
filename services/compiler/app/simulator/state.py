"""Immutable simulation value; parsing returns a fresh, private mutable working copy."""

import hashlib
import json
from dataclasses import dataclass

from app.models.contracts import BankStateSnapshotV1


@dataclass(frozen=True)
class SimulatedState:
    # JSON is the immutable value. It includes every V1 field and keeps the input version/time.
    snapshot_json: str
    source_state_version: int
    applied_operations: int = 0

    @classmethod
    def from_snapshot(cls, snapshot: BankStateSnapshotV1) -> "SimulatedState":
        return cls(snapshot.model_dump_json(by_alias=True), snapshot.state_version)

    def to_snapshot(self) -> BankStateSnapshotV1:
        return BankStateSnapshotV1.model_validate_json(self.snapshot_json)

    def advanced(self, snapshot: BankStateSnapshotV1) -> "SimulatedState":
        # Simulation is not a bank write: stateVersion and capturedAt stay at the source.
        return SimulatedState(
            snapshot.model_dump_json(by_alias=True),
            self.source_state_version,
            self.applied_operations + 1,
        )

    def digest(self) -> str:
        return canonical_state_digest(self)


def canonical_state_digest(state: BankStateSnapshotV1 | SimulatedState) -> str:
    """Stable visited-state identity; sequence depth is deliberately excluded."""
    snapshot = state.to_snapshot() if isinstance(state, SimulatedState) else state
    payload = snapshot.model_dump(mode="json", by_alias=True)
    for collection, key in (
        ("accounts", "id"),
        ("beneficiaries", "id"),
        ("assets", "id"),
        ("holdings", "assetId"),
        ("obligations", "id"),
        ("fxQuotes", "id"),
    ):
        payload[collection].sort(key=lambda item: item[key])
    for account in payload["accounts"]:
        account["capabilities"].sort()
    for beneficiary in payload["beneficiaries"]:
        beneficiary["supportedCurrencies"].sort()
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()
