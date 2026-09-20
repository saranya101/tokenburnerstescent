# Contract V1

Contract V1 freezes the wire boundary: Developer B produces `GoalContractV1`, Developer A supplies `BankStateSnapshotV1`, Developer C returns `CompilerResultV1`, and Developer A captures `ApprovalV1` and `ExecutionResultV1`.

Canonical Zod schemas live in `packages/contracts/src`. Matching Pydantic models live in `services/compiler/app/models/contracts.py`. Both runtimes validate the same fixtures under `packages/contracts/fixtures`.

## Wire conventions

- `schemaVersion` is the literal string `"1"`.
- IDs are non-empty strings and timestamps are ISO-8601 with a timezone.
- money is `{ currency, minorUnits }`; minor units are integer strings, never JS numbers.
- FX rates and asset quantities are decimal strings.
- enums use `UPPER_SNAKE_CASE`; boundary objects are strict.

`IntentDraftV1` and `GoalContractV1` are operation-free. Only `FinancialPlanStepV1` may contain `TRANSFER`, `FX_CONVERT`, `MOVE_FUNDS`, `PAY_BILL`, `BUY_ASSET`, or `SELL_ASSET`.

## Persistence mapping

Wire `GoalContractV1.id` is a stable logical ID and maps to Prisma `GoalContract.contractKey`; Prisma `GoalContract.id` is a row ID. Revisions are unique by `(contractKey, version)`. Plans and approvals retain `goalContractRowId` for relations plus `goalContractKey` and `goalContractVersion` for exact contract binding.

Snapshots are immutable frozen JSON compiler inputs. Relational tables retain queryable IDs, ownership, versions, statuses, hashes, and timestamps. Relational money uses `BigInt` minor units; FX rates and quantities use `Decimal`.

Entity aliases and pgvector produce retrieval candidates only and never authorize transactions.
