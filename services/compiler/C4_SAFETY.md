# C4 execution safety

`app.preflight.preflight_plan` validates a C3 money-movement plan as untrusted
data. It checks goal identity/version, canonical plan hash, sequential IDs and
dependencies, supported actions, operation metadata, grounded final completion,
quote bindings and expiry, policy, C1 preconditions/effects, C2 constraints, and
projected balances. It simulates from the supplied real snapshot without
mutating it. A different state version triggers validation, not automatic
rejection. For an outstanding FX step, the deterministic C3 plan-ID commitment
must reproduce from the current goal, snapshot, hard rules, policy, and route;
this proves the exact quote rate and fee still match the planning inputs.
If the state version or commitment differs, the old FX step is not cleared.

`ExecutionProgress.completed_step_ids` is an ordered prefix of steps whose
successful settlement is known to the trusted caller. Completed steps are never
simulated again; remaining steps start from the current real snapshot. Unknown
results and non-prefix progress fail closed. For current supported goals, an
exact final transfer or move is the atomic completion event. Prior moves and FX
conversions leave the full grounded goal outstanding. No beneficiary balance
or partial-payment state is invented.

`check_step_goal_preservation` checks only the proposed next step against C1,
C2, and policy, then simulates it. For a non-final step it calls the plain C3
compiler once from that hypothetical state. If the goal becomes impossible,
the step returns `WOULD_BREAK_GOAL` even when it is individually valid. If the
compiler finds a different remaining route, it returns `REPLAN_REQUIRED`.
For an outstanding FX step whose old binding cannot be proven, it may identify
an impossible final goal but never returns `PRESERVED`. C4 calls do not invoke
one another recursively.

`revalidate_plan` first preflights the remaining approved route. A passing
route is `PLAN_STILL_VALID`, including after an unrelated non-FX state change.
Otherwise one bounded C3 call classifies an alternate route as
`REPLAN_REQUIRED`, no route as `GOAL_NOW_UNSAT`, and bank permission failures as
`POLICY_BLOCKED`. Search ambiguity or exhaustion returns `CANNOT_PROVE_SAFE`.
`PlanDifference` reports changed source, FX count, quote IDs, fees where
available, operation types, irreversible count, beneficiary, amount, and safely
comparable total cost. These are facts for Person A; no approval decision is
made. Internal results expose step, compiler-call, and replan counts.

Limits: Contract V1.1 does not store a standalone FX rate/fee fingerprint on
each step. The C3 plan-ID commitment proves it only against exactly matching
planning inputs. After an unrelated state-version change, an outstanding FX
step requires a new plan. A partially executed route with `MAX_TOTAL_COST`
cannot reconstruct prior cost provenance from the current snapshot alone and
returns `CANNOT_PROVE_SAFE`. The existing HTTP `/v1/revalidate` stub does not
pass persistent hard rules or policy configuration; C4's trusted Python API is
the safety interface until service integration provides those inputs. No shared
contract or DB field was changed.
