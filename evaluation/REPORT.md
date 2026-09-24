# C7 compiler evaluation

Run with `python3 evaluation/compiler/run.py` from the repository root. The harness exits nonzero on failed correctness, comparison, adversarial, or determinism assertions. Expected outcomes are declared in `evaluation/compiler/scenarios.py`. Correctness JSON is stable across runs; measured timing is isolated in `performance-results.json` and changes with the machine and load.

## Dataset and correctness

- 78 declared cases across basic planning, constraints, policy, FX, search, preflight, goal preservation, revalidation, replanning, relaxation, opportunities, and adversarial state changes.
- Planning: 36 / 36 correct outcomes; 16 checked SAT routes; 0 incorrect accepts and 0 incorrect rejects.
- Adversarial: 17 / 17 passed; failed: [].
- Whole-plan preflight, changed-state revalidation, three replanning outcomes, exact relaxation boundaries, and five opportunity facts are checked by their declared cases.

## Baseline comparison

The baseline receives the same bank snapshot, hard rules, policy, approved goal, and proposed operation sequence as Parlance. It calls the same C1 simulator, C2 policy engine, and constraint evaluator at each step. It checks local and cumulative validity but does not synthesize another route or prove that a valid intermediate action preserves the approved final goal. These are 11 shared scenarios; the generated plan supplies the baseline sequence, so this is a comparison of execution-safety architecture rather than independent route generation.

- Locally valid steps allowed: baseline 5; Parlance 1.
- Stranded intermediate steps: baseline 3; Parlance blocked 3 harmful intermediate steps.
- Successful final outcomes or ready replacement plans: baseline 1; Parlance 2 (1 safe replan). No banking execution was performed.
- Policy violations allowed: baseline 0, Parlance 0. Constraint violations allowed: baseline 0, Parlance 0.
- In `goal_preservation_transfer_outage`, the baseline locally permits FX and then cannot transfer; Parlance classifies FX as `WOULD_BREAK_GOAL` before it can run.

## Determinism and search

- 140 repeated compiles had 0 mismatches in status, route, IDs, hash, or structured reason. Three cases also matched across two Python hash seeds; seed mismatches: 0.
- Mean states explored 29.25; maximum 1000; mean candidates evaluated 143.83; search-bound failures 3. Solver calls: 0.

## Measured performance

One measured run on the local machine; these are observations, not service-level guarantees. Benchmarks use two currencies, two quotes, and a 150-state cap.

| Graph | Accounts | Compile ms | States | Candidates | Result |
|---|---:|---:|---:|---:|---|
| SMALL | 4 | 15.16 | 41 | 84 | UNSAT / AMBIGUOUS_VALID_PLANS |
| MEDIUM | 12 | 383.58 | 150 | 1844 | UNSAT / MAX_STATES_EXPLORED |
| LARGE_HACKATHON | 36 | 2364.09 | 150 | 6362 | UNSAT / MAX_STATES_EXPLORED |

Measured mean operation latencies (ms): compileLatencyMs 14.766, preflightLatencyMs 0.145, goalPreservationLatencyMs 0.256, revalidationLatencyMs 0.294, relaxationLatencyMs 3.287.

## Limits and findings

- BUY_ASSET and SELL_ASSET route synthesis and trade-price approval binding remain deferred. Unsupported mixed-currency cost attribution fails closed.
- Search is bounded by depth and state count. The loop graph reaches the cap, and medium and large benchmarks may return bounded UNSAT rather than prove financial infeasibility.
- Opportunities are read-only. The current HTTP API may not pass all hard-rule and policy context. C4 partial-cost provenance can fail closed.
- This pass corrected fully funded frozen-account policy classification and added malformed-balance and malformed-goal-amount fail-closed handling. No shared contract or database change was needed.
- The baseline's 10 whole-goal failures include cases where it stops safely before any step; only its 3 stranded intermediate steps demonstrate the whole-goal safety gap.
