# C3B planner hardening

`PAY_BILL` synthesis is deferred. `GoalContractV1` identifies a `billerId`, but
`FinancialPlanStepV1` and the C1 operation require an `obligationId`.
`BankStateSnapshotV1.obligations` has no `billerId` or other canonical link to
the grounded biller. Matching by description or selecting an arbitrary obligation
would risk paying the wrong bill. C1 `PAY_BILL` simulation remains available.
To support synthesis safely, a shared contract revision needs a grounded
`obligationId` on the bill goal and a verifiable biller-to-obligation binding
on snapshot obligations (or an equivalent canonical relation), including the
rule for multiple obligations from one biller. No shared contract was changed.

The planner compares routes by a pure material signature: final canonical state,
grounded completion, external spending, nonzero fees, irreversible operation
types/counts, and used quote expiries. This ignores step IDs, quote IDs with
identical economics and validity, and commutative ordering of equivalent moves.
Distinct funding consequences remain material because they change the final
account balances. Ordered preferences filter valid plans; if the best preference
score still leaves materially different routes, compilation returns structured
`AMBIGUOUS_VALID_PLANS`. Equivalent finalists use step count and the stable C1
operation key as a total tie-break. `FASTEST` means fewest steps; no latency
model is assumed. Cost comparison uses C2 attribution and fails closed when
currency conversion is unsupported.

Search is deterministic BFS with sorted candidates, a configurable depth limit
(default four), and a configurable state-exploration limit (default 1000).
Canonical state/history tracking prevents return-to-previous-state cycles.
Hitting the state limit returns `MAX_STATES_EXPLORED` even if partial search found
a plan, because ranking may be incomplete. The internal diagnostics record
`states_explored`, `candidate_actions_evaluated`, `search_depth_reached`,
`solver_calls`, `pruned_by_policy`, `pruned_by_constraint`,
`pruned_visited_states`, and `valid_plans_found`. No public plan or DB field was
added.

Failure precedence is: input identity/goal validation; search-state exhaustion;
blocked or unverified beneficiary and missing beneficiary; unavailable transfer
service; observed liquidity, maximum-cost, and exclusion violations; observed
bank-policy violations; missing move destination; expired target quote; search
depth exhaustion; then route-specific source, destination, FX, and funding
reasons. This preserves `POLICY_BLOCKED` for bank permission failures and `UNSAT`
for financial or request-constraint infeasibility. A bounded search can only
classify failures from candidates inside its search horizon.
