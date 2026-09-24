# Contract V1

Contract V1 freezes the wire boundary between language grounding and deterministic compilation.

```text
Person B: human language
          -> IntentDraftV1
          -> grounding / ambiguity resolution
          -> GoalContractV1 with canonical IDs

Person C: GoalContractV1 + BankStateSnapshotV1
          -> CompilerResultV1
```

The compiler never resolves human references. Developer A supplies `BankStateSnapshotV1`, then captures `ApprovalV1` and `ExecutionResultV1` around the compiled plan.

Canonical Zod schemas live in `packages/contracts/src`. Matching Pydantic models live in `services/compiler/app/models/contracts.py`. Both runtimes validate the same fixtures under `packages/contracts/fixtures`.

## Wire conventions

- `schemaVersion` is the literal string `"1"`.
- IDs are non-empty strings and timestamps are ISO-8601 with a timezone.
- money is `{ currency, minorUnits }`; minor units are integer strings, never JS numbers.
- FX rates and asset quantities are decimal strings.
- enums use `UPPER_SNAKE_CASE`; boundary objects are strict.

`IntentDraftV1` and `GoalContractV1` are operation-free. Only `FinancialPlanStepV1` may contain `TRANSFER`, `FX_CONVERT`, `MOVE_FUNDS`, `PAY_BILL`, `BUY_ASSET`, or `SELL_ASSET`.

`IntentDraftV1` may contain human-facing fields such as `assetReference`, `recipientReference`, `accountReference`, and `billerReference`. `GoalContractV1` replaces them with `assetId`, `recipientId`, `accountId`, and `billerId`. `entityBindings` retain the original reference-to-ID decisions for audit and explanation.

An `ACQUIRE_ASSET` goal accepts `budget`, `quantity`, or both, but never neither. Budget-only delegates feasible quantity calculation to the deterministic compiler. Quantity-only delegates funding calculation. When both are present, quantity is the target and budget is the hard spending maximum.

An executable `FX_CONVERT` step binds `sourceAccountId`, `destinationAccountId`, `sourceMoney`, `targetCurrency`, and `quoteId`. The destination account is the exact account credited by deterministic simulation and authorized for execution; it cannot be inferred from the target currency at execution time.

## Persistence mapping

Wire `GoalContractV1.id` is a stable logical ID and maps to Prisma `GoalContract.contractKey`; Prisma `GoalContract.id` is a row ID. Revisions are unique by `(contractKey, version)`. Plans and approvals retain `goalContractRowId` for relations plus `goalContractKey` and `goalContractVersion` for exact contract binding.

Snapshots are immutable frozen JSON compiler inputs. Relational tables retain queryable IDs, ownership, versions, statuses, hashes, and timestamps. Relational money uses `BigInt` minor units; FX rates and quantities use `Decimal`.

Entity aliases and pgvector produce retrieval candidates only and never authorize transactions.
