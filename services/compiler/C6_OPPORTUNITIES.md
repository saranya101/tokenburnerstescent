# C6 opportunity engine

`app.opportunities.discover_opportunities` is an internal, read-only calculation over a trusted `BankStateSnapshotV1`, enabled persistent `HardRule`s, a `PolicyEngine`, and optional already-grounded goal templates. It returns immutable `OpportunityCandidate`s and diagnostics. It creates no plan, approval, executable operation, database row, or customer-facing wording.

## Supported facts

Candidates appear in a fixed type and currency order. There is at most one candidate per type, currency, and state version.

- `AVAILABLE_ABOVE_RESERVE`: liquidity from active, transfer-capable, non-excluded accounts, protected by effective persistent minimum balances. Each source uses the lesser of C2 available liquidity and ledger balance. Account-specific floors and the global floor both apply conservatively.
- `AVAILABLE_AFTER_OBLIGATIONS`: the above amount less relevant obligations, clamped to zero.
- `GOAL_AMOUNT_FEASIBILITY`: the exact maximum for one trusted grounded `DELIVER_MONEY` or `MOVE_FUNDS` template. C5 searches the amount bound through the ordinary C3 compiler. C6 independently requires amount X to compile to SAT and X + 1 minor unit to compile to ordinary UNSAT. Search exhaustion and ambiguous results suppress the candidate. Obligations are added to the probe as an internal minimum-balance floor.
- `EMERGENCY_RESERVE_GAP`: the shortfall against an existing enabled persistent `MIN_AVAILABLE_BALANCE` rule. There is no generated reserve target.
- `UPCOMING_OBLIGATION_COVERAGE`: the amount of supported obligations covered by protected liquidity and the exact shortfall.

The first, second, fourth, and fifth types are accounting facts, not generic executable amounts. Where exactly one matching grounded template is provided, positive liquidity facts are also checked by the normal compiler and suppressed if that amount is infeasible. Exact maximum claims are made only by `GOAL_AMOUNT_FEASIBILITY`. A generic maximum cannot be proved without a grounded recipient or destination, so C6 does not invent one.

## Obligations and time

Contract V1.1 represents obligation statuses as `OPEN`, `OVERDUE`, `PAID`, and `CANCELLED`. C6 reserves `OPEN` and `OVERDUE` obligations due on or before `capturedAt + horizon` (default 30 days); it ignores paid, cancelled, and later obligations. The boundary is inclusive. Mixed-currency obligations suppress combined calculations because C6 has no obligation-specific conversion basis. Duplicate identifiers and invalid balances also fail closed.

Every candidate carries its source `stateVersion`. Expiry is deterministic from snapshot `capturedAt` plus the configured TTL (default 60 minutes); obligation-dependent candidates expire no later than the earliest future relevant due date. A compiler-proven FX maximum expires no later than the plan's required quote. Any state-version change requires recalculation before a selected possibility enters the normal pipeline.

## Handoff and limits

C6 has no opportunity-to-goal conversion helper: the recipient or destination must be grounded and confirmed by Person B or the product layer. The resulting `GoalContractV1` must run through the normal compiler, approval, and execution path. The existing `/v1/opportunities` route is not wired to these internal candidates because its request and public response mapping are not part of C6. No shared-contract change is needed for this internal engine; a future public opportunity response would need an explicit wire-contract decision.
