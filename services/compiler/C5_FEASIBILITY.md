# C5 deterministic feasibility

`replan_goal` calls C4 `revalidate_plan`. A still valid plan is returned unchanged.
An available C4 alternate becomes `REPLANNED` only after the new plan is checked
against the exact approved grounded target and amount. No approval or execution
decision is made. `PlanDifference.code` gives stable machine-readable facts for
source and destination changes, FX added or removed, quote change, step count,
operation sequence, fees, comparable total cost, and irreversible step count.
The existing C4 difference data remains available.

`explain_unsat` wraps the real C3 result and retains rejected-route diagnostics
as secondary evidence. The compiler's terminal reason remains primary because
a violation on one rejected path does not prove all paths share it. Primary
reason precedence is therefore C3's documented precedence: beneficiary/policy,
then request liquidity, cost, and exclusion constraints, then quote, bounds,
and route/funding failures. Search exhaustion, ambiguous plans, and unsupported
cost comparison are classified `CANNOT_PROVE_SAFE`, not financial impossibility.
Policy failures remain separate and receive no relaxation.

`analyze_request_relaxations` changes one request-level numeric constraint at a
time on a deep copy of the goal. It never edits persistent hard rules. For
`MAX_TOTAL_COST`, raising the limit can only retain or add valid bounded routes;
doubling finds a feasible upper bound and integer binary search finds the
minimum feasible ceiling. For `MIN_AVAILABLE_BALANCE`, lowering a request
reserve can only retain or add routes; integer binary search finds the highest
feasible reserve between zero and the current request. Every probe calls the
real C3 compiler. An unknown/ambiguous/bound-limited probe stops with
`CANNOT_PROVE_SAFE`. The returned number is a proven SAT boundary for one
changed request constraint, not an automatic rule change or a combined
multi-constraint recommendation.

`find_max_feasible_amount` supports grounded `DELIVER_MONEY` and `MOVE_FUNDS`
with an explicit nonnegative upper bound. For these atomic exact-amount goals,
a smaller positive amount cannot require more principal than a larger one,
while fixed fees and reserve thresholds do not increase as amount decreases.
It binary-searches exact integer minor units and rechecks the chosen value with
the compiler. Ambiguous or search-limited probes fail closed. A zero maximum
means no positive amount was proven feasible, and the approved GoalContract is
never rewritten. Both numeric utilities expose compiler calls, iterations,
bounds, and final value.

Current limits: C3 route search is bounded, so a result is relative to its
configured search horizon. The C3 candidate enumerator can fail to find a
route outside its supported money-movement shapes. `PAY_BILL` synthesis and
trade goals remain deferred. Relaxations are analyzed independently, and
approval/policy rules are not inferred from feasibility facts. No shared
contract, DB, UI, or banking-execution code changed for C5.
