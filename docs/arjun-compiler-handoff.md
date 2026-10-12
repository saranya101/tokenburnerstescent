# Arjun compiler workstream — review handoff

Date: 12 October 2026. Branch: `arjun`. Review required before commit, push or merge.

## A. Summary

P0 compiler work is complete for the fixed transfer-then-investment scenario and the represented safety boundaries. Bundles now reuse the standalone acquisition compiler, including its existing explicitly authorized FX route. Bundle verification checks backward dependencies, item funding dependencies, unique operation ownership, operation policy, input-bound plan identity, exact projections and quote validity.

P1 feasibility is complete, with five isolated probes and a narrow conditional GO recommendation. No production alternative generator, new route, shared schema, execution or authentication change was implemented. Live browser execution and the new fixture's end-to-end API execution remain **NOT TESTED**; these belong to Saranya's integration work.

No persistent bank state, database, migration, credential, real bank or browser passkey ceremony was used. API checks ran with in-memory fixtures and stripped database/external-service environment variables.

## B. Root causes / defects

| Defect | Reproduction against original HEAD | Correction |
|---|---|---|
| Bundle investments bypassed existing FX-funded acquisition | Exact SGD headline returned `UNSAT / INSUFFICIENT_FUNDS`, although authorized funding was sufficient | Use normal single-goal compilation against the evolving simulated snapshot; verify the complete acquisition route against its item-start snapshot |
| Dependency validation checked existence but not execution direction | A rehashed funded-USD plan with transfer depending on the later buy passed original verification | Reject absent, self, cyclic and forward step dependencies; require each item precursor to be an ancestor of its next operation |
| Projections and validity were trusted after plan hashing | Rehashed fabricated SGD balance and expiry extended to 2099 both passed original verification | Reconstruct expected outcome and validity from authoritative simulation and compare them; require input-bound plan ID |
| Proof allowed shared operation ownership | Existing ownership validation accepted any nonempty owner set, allowing a single operation to be claimed by multiple goals | Require exactly one item owner per step; a mutation regression exercises two requested transfers |
| Decimal quantity coverage used text equality | Confirmed `1.00` normalized to plan `1`, so material equality could fail coverage | Compare exact Decimal values; three spelling regressions pass |
| Bundle direct acquisition skipped standalone invalid-state guards | Investment branch called the operation helper directly | Shared compilation now applies existing state-amount validation; acquisition-only malformed balance refuses |

The first three original-code reproductions actually ran using `git show HEAD:services/compiler/app/planner/bundle.py` loaded into a separate in-memory module. No worktree files were replaced. The remaining findings are covered by new regression tests and code review; no claim is made that they affected a live customer.

## C. Files changed

| Path | Reason |
|---|---|
| `services/compiler/app/planner/bundle.py` | Reuse acquisition route and strengthen independent bundle verification |
| `services/compiler/tests/test_arjun_bundle_safety.py` | 62 parameterized cases for A1–A6, B1–B14, exact prefixes and policy binding |
| `services/compiler/tests/test_arjun_alternatives_feasibility.py` | Five compiler-only C1 feasibility probes; no production behavior |
| `services/compiler/tests/verify_http_contracts.ts` | Parse actual HTTP output with unchanged TypeScript schemas and verify synthetic bundle hashes |
| `services/compiler/tests/export_arjun_evidence.py` | Reproducible isolated HTTP fixture/prefix exporter |
| `docs/arjun-compiler-evidence.json` | Exact requests, responses and prefix states: three successes, 14 refusals |
| `docs/arjun-compiler-handoff.md` | Findings, test evidence, limitations and integration decision |

Shared contracts, Lucas's intent engine, Saranya's web/API, execution gateway and authentication files are unchanged.

## D. Multi-intent demonstration

Exact machine-readable input is `successFixtures[0].request` in `arjun-compiler-evidence.json`, accepted at `/v1/compile-bundle`. It contains:

- `bundleId: synthetic-transfer-then-aapl`, version 1.
- `send`: `DELIVER_MONEY`, recipient `john-lim`, SGD `10000` minor units.
- `buy`: `ACQUIRE_ASSET`, asset `aapl`, quantity `1`; existing confirmed `PREFER_ACCOUNT(sgd-source)` represents permission for non-settlement funding, as in standalone acquisition.
- Global `MIN_AVAILABLE_BALANCE`: SGD `100000`, account `sgd-source`.
- Explicit edge `send → buy`, reason `USER_EXPLICIT_ORDER`.
- Confirmed bindings for John Lim, Apple (AAPL), and the SGD account.
- Contract hash `324aaaf958dd5b4931334b11797daf4700395db6e38eb6811417166382f233c1`, checked with the actual TypeScript hash function.

Synthetic snapshot: user `synthetic-arjun`, state version 42, planning time `2026-10-12T00:00:00Z`. SGD source available/ledger `200000`; USD brokerage available/ledger `0`. Active SGD beneficiary John Lim supports SGD. Apple is tradable, settles in USD. No initial holdings or obligations. Relevant services are available.

Plan ID: `5616ac903b9e4c67d0597170d55894f8`. Let `P` denote that exact ID below.

| Sequence / ID | Action | Authoritative economics | Dependency |
|---|---|---|---|
| 0 / `P:0` | Transfer `sgd-source → john-lim` | SGD 100; transfer fee zero under existing transfer model | None |
| 1 / `P:1` | FX `sgd-source → usd-invest` | SGD 268 principal × rate 0.75 = USD 201; separate SGD 0.25 fee; quote `fx-fixed` | `P:0` |
| 2 / `P:2` | Buy AAPL from `usd-invest` | Exactly one share × USD 200 + USD 1 fee = USD 201; quote `aapl-fixed`; maximum spend USD 201 | `P:1` |

Only the USD shortfall is converted. Integer minor units and Decimal half-even rounding determine the smallest sufficient FX principal. Transfer and FX debit SGD `36825` total; projected SGD is `163175`, USD `0`. Projected acquisition is one AAPL share; replayed holdings are one AAPL share. `acquiredAssets` describes acquired quantities, not a full holdings portfolio: there is no shared projected-holdings field. The prefix states in the evidence include actual simulated holdings.

The plan binds state version 42 and both quote IDs. FX expires at `00:10:00Z`, asset quote at `00:05:00Z`; plan expiry is `2026-10-12T00:05:00Z`. Satisfaction proof binds the bundle hash; `send` covers step 0 and `buy` covers steps 1–2. All three operations are marked irreversible. Ten repeated compilations are identical, including IDs and hashes.

USD-funded variant: initial USD `20101` in the test yields transfer then buy, no FX, SGD `190000`, USD `1`; exported variant starts with USD `20100` and ends with USD `0`. Exact-reserve variant starts with SGD `136825` and ends with SGD `100000`.

## E. Safety verification

All inputs use `headline()`'s confirmed contract and authoritative synthetic state described above unless the row states a mutation. Expected and actual results agree. Each row is **PASS** for represented contract features; limitations follow the table.

| Requirement / test scenario | Fixture mutation / trust boundary | Expected result | Actual result |
|---|---|---|---|
| A1 SGD-funded bundle | USD zero; confirmed SGD funding | Transfer → FX → exactly 1 buy; exact fees/dependencies/projections | PASS |
| A2 existing USD | USD `20101` | No FX; USD ends `1`; SGD reserve intact | PASS |
| A3 no FX permission / missing preferred source | No funding preference, then nonexistent preferred account | No synthesized FX or source substitution; whole bundle UNSAT | PASS: `INSUFFICIENT_FUNDS` |
| A4 insufficient aggregate funding | SGD `36824`, reserve zero | Purchase short by one source cent after transfer; no partial plan | PASS: `INSUFFICIENT_FUNDING_FUNDS` |
| A5 reversed order | USD transfer `10000`, initial USD `25000`, SGD funding | Forward: transfer/FX/buy; reverse: buy/FX/transfer | PASS; FX shifts to the goal with the shortfall |
| A6 determinism / immutability | Fixed snapshot and quotes; repeat ten times | Identical full result; no input mutation | PASS |
| B1 protected reserve | SGD `136824` | Refuse, projected SGD `99999` below `100000` | PASS: `MIN_AVAILABLE_BALANCE_VIOLATED`, scope GLOBAL |
| B2 available vs settled | Independently lower each source's ledger or available balance | Ledger-only or unavailable money cannot fund operations | PASS: `INSUFFICIENT_FUNDS` |
| B3 missing investment quote | Empty asset quotes | No fabricated price or fallback | PASS: `ASSET_PRICE_UNAVAILABLE` |
| B4 expired investment quote | Asset expiry equals planning time | No stale purchase | PASS: `ASSET_PRICE_UNAVAILABLE` |
| B5 absent / expired FX quote | Remove quote / expiry equals planning time | No fabricated conversion/rate/fee | PASS: `NO_FX_ROUTE` / `QUOTE_EXPIRED` |
| B6 asset/service unavailable | Missing asset, nontradable asset, unavailable investments service | Fail closed | PASS: `ASSET_NOT_FOUND`, `ASSET_NOT_TRADABLE`, `REQUIRED_SERVICE_UNAVAILABLE` |
| B7 beneficiary authority | Unknown ID, BLOCKED, PENDING_VERIFICATION, EUR-only recipient | No plan to invalid recipient | PASS: `BENEFICIARY_NOT_ALLOWED`, `BENEFICIARY_BLOCKED`, `BENEFICIARY_UNVERIFIED`, `NO_TRANSFER_ROUTE` |
| B8 settlement account | EUR currency, frozen account, no TRADE_ASSET capability | No currency-mismatched purchase | PASS: `NO_ELIGIBLE_SETTLEMENT_ACCOUNT` |
| B9 double spending | SGD `30000`, reserve zero; each goal separately feasible | Combined evolving-state bundle refuses | PASS: `INSUFFICIENT_FUNDING_FUNDS` |
| B10 item/global scope | SGD `136824`; reserve private to send, then also private to buy | Send-only reserve permits later unscoped spend; buy/global reserve refuses | PASS |
| B11 bundle graph | Missing endpoint, self edge, duplicate edge, cycle | Reject input at model/HTTP boundary | PASS: ValidationError / HTTP 422 |
| B11 step graph | Missing, forward, cyclic edge; missing FX prerequisite | Reject rehashed plan | PASS: verifier returns false |
| B11 goal coverage | One transfer claimed by two requested transfers | Reject fabricated satisfaction | PASS: verifier returns false |
| B12 reserve boundaries | SGD `136824`, `136825`, `136826` | One cent below fails; exact/above pass | PASS |
| B12 FX rounding/fee | USD shortfall one cent, rates .75/.5 | Minimum SGD principal 1/2 cents; fee 25 cents charged separately | PASS |
| B12 decimal cost | Quantities .5/.333; prices `20000`/`20001` | Exact totals `10100`/`6760`; fractional minor-unit cost refuses | PASS: `ASSET_QUOTE_NOT_MINOR_UNIT_EXACT` |
| B12 decimal spelling | Confirmed `1.0`, `1.00`, `0.50` | Numerically equal normalized plan quantities satisfy coverage | PASS |
| B12 invalid targets | Negative transfer; negative/exponential quantity | UNSAT or contract rejection; no executable plan | PASS: `INVALID_AMOUNT` / ValidationError |
| B13 bindings | Changed state version, quote price/rate, capturedAt at expiry | Old plan invalid | PASS: verifier returns false |
| B13 same rounded output | Rate .75000001 instead of .75 | Changed quote economics cannot retain old input-bound plan | PASS |
| B13 invalid snapshot amount | Acquisition-only bundle; malformed available balance | Controlled refusal, no exception/plan | PASS: `INVALID_STATE_AMOUNT` |
| B14 real HTTP boundary | SGD/USD success, reserve/no-permission refusal; standalone buy/transfer | Actual JSON parses in TypeScript; absent optional fields omitted | PASS; bundle hashes also checked |
| Multiple funding accounts | Two explicitly preferred FX sources; one item-excluded | Skip excluded account, use eligible authorized source | PASS |
| Policy allowlist | Allow transfer/buy, then disallow buy | Valid restricted-policy plan verifies; disallowed purchase refuses | PASS: `POLICY_BLOCKED / OPERATION_NOT_ALLOWED` |
| Partial completion | Replay exact plan one operation at a time | Prefix balances/holdings preserve real effects; no rollback | PASS |

Meaningful tests are the correspondingly named `test_a*`, `test_b*`, mutation, policy, multiple-funding and prefix functions in `test_arjun_bundle_safety.py`. Parameter values, exact contract state and assertions are in that file; the table records expected and actually observed outcomes and trust boundaries. Existing scope/cost tests in `test_bundle_compiler.py`, transfer/search tests in `test_planner_c3a.py`/`test_planner_c3b.py`, and operation/Z3 tests also passed.

### Unsupported assumptions and practical limits

- B2: Snapshot V1 distinguishes available and ledger balances, account status/capabilities. It has no pending/unsettled buckets. The compiler checks both balances; the bank adapter must exclude restrictions/unsettled funds from available funds. Separate pending-funds behavior is **NOT TESTED / not representable**.
- B7: Beneficiary/account ownership is not stored on individual snapshot entities, and bundle V1 has no userId. API must fetch the stored confirmed bundle and authoritative snapshot for its owner. A foreign ID absent from that snapshot refuses; a forged snapshot containing foreign entities cannot be identified as foreign by this compiler. Existing cross-customer security assurance passed; compiler per-entity ownership is **not representable**.
- B12: Quantity strings support decimals, but the asset contract has no lot size or fractional-share eligibility. Decimal arithmetic tests do not establish that Apple fractional shares are an allowed product. Proposed alternatives must use positive whole shares for the demo.
- B13: Quote expiry is evaluated against authoritative `capturedAt`, enabling fixed-clock compilation. The compiler does not set an age bound or compare capturedAt to wall time. Snapshot freshness/uniqueness and caller identity are bank/API responsibilities. No freshness guarantee is claimed for arbitrary stale direct HTTP inputs.
- Global constraints are checked across the combined route at completion; transfer search also evaluates merged constraints at item completion. Private constraints apply to an item's operations and its completion state, not subsequent unrelated items. API additionally checks state constraints after each operation. The flagship scenario's protected SGD balance only decreases, so every prefix remains above reserve. General temporary reserve depletion followed by restoration is not newly supported or promised.
- Acquisition planning remains deterministic bounded route enumeration, not a complete optimizer across all bundle goals. A funded settlement account that violates a global constraint can cause a safe refusal even when another discretionary route could work. Combining several partial FX sources for one investment is not implemented; refusal is safe. These limitations do not create permissive plans.

## F. Test results

Canonical Python environment: `services/compiler/.venv`, Python 3.12.15, Z3 installed. Original focused baseline: **62 passed**, zero skips, one FastAPI/TestClient dependency deprecation warning.

The shell initially had Node 20 and no `pnpm` on PATH. Corepack's pinned pnpm requires newer Node. Verification used existing Node 22.23.3 and a temporary Corepack shim, pnpm **11.19.0**. No dependency manifests or lockfiles changed:

```bash
export PATH=/tmp/athena-mobile-tools/node_modules/node/bin:/tmp/parlance-arjun-tools:$PATH
```

| Executed command | Final result |
|---|---|
| `cd services/compiler && ./.venv/bin/pytest tests/test_bundle_compiler.py tests/test_planner_c3a.py` (baseline) | 62 passed, 0 skipped |
| `cd services/compiler && ./.venv/bin/pytest tests/test_arjun_bundle_safety.py tests/test_bundle_compiler.py tests/test_planner_c3a.py tests/test_planner_c3b.py` | 135 passed, 0 skipped |
| `cd services/compiler && ./.venv/bin/pytest tests/test_arjun_alternatives_feasibility.py` | 5 passed, 0 skipped |
| `pnpm compiler:test` | 273 passed, 0 skipped, one dependency deprecation warning |
| `pnpm compiler:lint` | Ruff lint and formatting PASS, 50 Python files formatted |
| `pnpm --filter @parlance/contracts test` | 80 passed, 8 files, 0 skipped |
| `pnpm --filter @parlance/contracts typecheck` | PASS |
| `pnpm security:assurance` | 8 scenarios passed; 13 focused checks; no failed scenario |
| Isolated API command below | 66 passed, 2 files, 0 skipped |
| `apps/api/node_modules/.bin/tsx services/compiler/tests/verify_http_contracts.ts docs/arjun-compiler-evidence.json` | PASS for every valid exported request/result; malformed dependency fixture intentionally HTTP 422 |
| `cd services/compiler && PYTHONPATH=. ./.venv/bin/python tests/export_arjun_evidence.py` | 3 success / 14 refusal / 3 prefix fixtures exported; byte-identical repeated export |
| `git diff --check` | PASS |

Exact additional in-memory API command:

```bash
env -u TEST_DATABASE_URL -u DATABASE_URL -u DIRECT_URL \
  -u TOKENHUB_API_KEY -u OPENAI_API_KEY -u MOCK_BANK_URL -u COMPILER_URL \
  -u REDIS_URL -u PARLANCE_INTERNAL_API_TOKEN -u PARLANCE_OPS_API_TOKEN \
  -u PARLANCE_BANK_API_TOKEN NODE_ENV=test \
  pnpm --filter @parlance/api exec vitest run \
  src/orchestration/bundle-orchestration.test.ts \
  src/orchestration/vertical-slice.test.ts
```

No persistent TEST_DATABASE_URL was used. PostgreSQL concurrency, live browser/passkey integration and full repository build/test are **NOT TESTED**. Shared interfaces/dependencies were not changed, so the complete compiler suite, contracts checks and relevant isolated integration/security regressions were the selected quality gates. Early test failures were fixture expectations, request-side optional-null serialization and local PATH setup; corrected runs are recorded above. The initial final lint run caught two long exporter strings, subsequently corrected.

## G. Safe alternatives — C1 decision

**GO for a narrow deterministic proposal design, conditional on Saranya's approval. NO-GO for broad production alternatives in this change.** The compiler can prove selected revisions with normal recompilation. This can improve the refusal experience before the deadline if the proposal consent UI/API work fits the remaining schedule; it is not worth destabilizing P0.

Existing paths:

| Path | Capability / restriction |
|---|---|
| `app/opportunities.py` | Reserve headroom, obligations and compiler-proven single transfer/move template feasibility; informational dataclasses, no execution |
| `app/relaxation.py::find_max_feasible_amount` | Exact bounded search with cloned transfer/move goals and normal compilation; unsupported for investment/bundle goals |
| `app/relaxation.py::analyze_request_relaxations` | Hypothetical thresholds including reduced reserve; **must not be used unchanged** as safe-alternative suggestions |
| `app/replanning.py` / `app/revalidation.py` | Existing single-goal evidence/replanning, not bundle investment revisions; target preservation checks only transfer/move |
| `app/main.py::opportunities` | HTTP stub returns `[]`; existing internal opportunities are not exposed here |
| `app/main.py::revalidate` | HTTP version-only stub; not full revalidation |
| Existing goal/bundle contracts | Can express positive reduced transfers, whole-share purchases or selected remaining goals; no proposal provenance/consent/expiry envelope |

The five executed tests prove: single-goal maximum transfer SGD360 while preserving SGD1000 on a SGD1360 snapshot; a distinct bundle proposal transferring SGD91.75 plus one share preserves exactly SGD1000 and SGD91.76 fails; either isolated goal may be feasible while the original bundle remains failed; no positive proposal above a fully protected SGD1000 balance is forced; stale asset quotes and excluded accounts still refuse.

### Proposed data flow and exact changes for a later approved implementation

1. Keep the original UNSAT record. A deterministic compiler helper clones the original contract, preserving **all** global protections and item protections for retained items. Do not call reserve relaxation.
2. Generate a bounded set of positive whole-share/transfer candidates. For the simple one-SGD/one-USD fixed route, compute headroom using `min(available, ledger)`, the confirmed reserve, exact shortfall conversion and fees. General cases require full candidate recompilation; do not assume feasibility is monotone across account selection, ambiguity or routing boundaries.
3. Recompile each candidate through `compile_goal_bundle`; discard non-success, uncertain, stale, ineligible or unsupported proposals. Do not call gateway/execution. Candidate plans are evidence, never customer authorizations.
4. Present a clearly labeled **revised proposal** with its original failed bundle reference, precise changes, preserved protections, snapshot and quote expiry. If none is proven, show “No safe alternative available.”
5. Customer explicitly elects a revision; pass it through the existing meaning confirmation/grounding and fresh contract hashing/versioning. Saranya and Lucas own that flow. Do not present a hypothetical CONFIRMED test contract directly as customer consent.
6. Obtain current state/quotes and compile again. Customer reviews and provides a **new** exact-plan passkey authorization. Superseded/rejected-plan approvals never transfer.

Minimal proposed envelope, if structured suggestions are needed: separate `SafeAlternativeProposalV1` with `proposalId`, `originalBundleId`, `originalContractHash`, `proposedIntentBundle` (existing draft type), `changedItemIds`, `bankStateVersion`, `requiredQuoteIds`, `expiresAt`; an informational proposal response containing `proposals: []` supports no-alternative. This is a **proposal for team discussion**, not an added schema. Attaching an `alternatives` field to current strict UNSAT schemas would break compatibility. A new optional route/envelope requires Saranya and shared-contract team agreement, with Lucas reviewing proposed meaning/grounding. No changes to financial goal, plan, gateway or passkey schemas should be necessary. An explanation-only revised-request suggestion could use existing messaging, but must still route back through normal confirmation.

Risks: mistaking headroom for routed feasibility; dropping item constraints while omitting goals; inventing FX consent; interpreting PREFER_ACCOUNT as permission without explicit user wording; reusing stale quotes; transferring old approval; calling fractional quantities tradable; suggesting reserve reductions. The current contract has no explicit transfer-minimum constraint, so do not promise reductions respecting such a minimum until its representation is agreed.

Estimate (engineering judgment): roughly one day for a narrowly bounded compiler helper/tests, plus one to two days for proposal API/UI, consent, expiry and integration verification. Broad multi-source optimization/product-rule support is beyond that scope. Required minimal tests: exact/±one-cent reserve, fees/rounding, expired quotes and changed balances, excluded/preferred sources, multiple authorized sources, explicit transfer minimum if supported, whole-share eligibility, separate original/revised hashes, omitted-goal consent, no positive alternative, zero gateway calls, no approval inheritance. Approval has not been obtained; production work remains gated.

## H. Integration handoff for Saranya

`arjun-compiler-evidence.json` contains complete POST bodies and actual HTTP results. Its synthetic IDs are fixture IDs, not demo account IDs. Fixed quotes are historical after their stated expiry; replay them with the fixture clock only. For a live demo obtain current authoritative quotes and a current snapshot, then confirm the real entity references.

### Refusal evidence

| Fixture | HTTP / status / reason | UI evidence |
|---|---|---|
| Protected reserve | 200 / UNSAT / `MIN_AVAILABLE_BALANCE_VIOLATED` | Scope GLOBAL, account, currency, required `100000`, projected `99999`; derive shortfall `1` |
| Insufficient funding | 200 / UNSAT / `INSUFFICIENT_FUNDING_FUNDS` | State version 42, authorized funding-account IDs, buy item ID |
| Unauthorized FX | 200 / UNSAT / `INSUFFICIENT_FUNDS` | Required USD `20100`, currency, state version, item scope |
| Missing/expired asset quote | 200 / UNSAT / `ASSET_PRICE_UNAVAILABLE` | Asset ID, state version, buy item ID; existing reason does not distinguish expiry from missing |
| Missing/expired FX quote | 200 / UNSAT / `NO_FX_ROUTE` or `QUOTE_EXPIRED` | Currency, state version, item scope; no invented rate/fee |
| Nontradable/unknown asset | 200 / POLICY_BLOCKED or UNSAT / `ASSET_NOT_TRADABLE` or `ASSET_NOT_FOUND` | Asset ID and item scope |
| Currency/beneficiary | 200 / UNSAT / `NO_ELIGIBLE_SETTLEMENT_ACCOUNT`, `NO_TRANSFER_ROUTE`, `BENEFICIARY_NOT_ALLOWED` | Settlement currency/asset, send item, or beneficiary ID as available |
| Blocked beneficiary | 200 / POLICY_BLOCKED / `BENEFICIARY_BLOCKED` | Beneficiary ID, send item |
| Invalid dependency | 422 / request-validation failure | Pydantic location/message in `detail`; not a financial UNSAT result |

No refusal contains a partial executable plan. A hypothetical failed simulation is not bank execution. Some codes intentionally have sparse explanation metadata; don't invent a numeric shortfall where it isn't provided.

### Partial completion and failure points

| Settled prefix / later definite failure | SGD available/ledger | USD available/ledger | Holdings | Bundle result |
|---|---:|---:|---|---|
| Transfer completed; FX not completed | 190000 | 0 | None | Transfer achieved; investment outstanding; overall failed/incomplete |
| Transfer and FX completed; purchase not completed | 163175 | 20100 | None | Transfer achieved; converted funds remain USD; overall failed/incomplete |
| All completed | 163175 | 0 | AAPL 1 | Both goals achieved |
| Bank outcome unknown | Use last reconciled state; actual effect may be before or after uncertain operation | Same rule | Same rule | UNKNOWN, achieved false; block dependent operations and reconcile |

No transfer, FX or purchase is automatically reversed. Do not label the original bundle successful after only the transfer. Unknown outcomes require bank receipt/idempotency lookup before determining balances, retrying or advancing. Prefix snapshots keep version 42 because pure simulation is not a bank mutation; actual bank versions must come from execution receipts/reconciliation.

Read-only API review: `services.ts` simulates the remaining bundle before writes, checks covered-item constraints, records prior step results on failure, reports `achieved: false` for failure/unknown, and reports complete only after every step. UNKNOWN reconciliation and exact approval binding have existing isolated coverage. The isolated API suite passed 66 tests, but it does not execute the newly exported Python-produced three-step fixture end to end. Saranya should add isolated integration coverage for failure at FX, failure at buy, changed/expired FX and asset quotes, and unknown receipts at each step using this fixture.

Other integration concerns: verify amount/FX permission semantics are retained from confirmed meaning; do not treat a generic account preference inserted without explicit consent as funding authority. Continue API-side current-state remainder simulation rather than relying on compiler HTTP `/v1/revalidate`'s version-only result. Clarify general per-prefix versus final-scope reserve semantics with the shared-contract owners before extending to arbitrary move/restore bundles. Operation dependencies and policy checks are guaranteed by these compiler tests; live reconciliation, approvals and customer reporting are integration responsibilities.

No immediate shared-contract change is needed for A/B. A full projected portfolio field would be a separate approved extension; current `acquiredAssets` plus synthetic replayed holdings supplies demo evidence. A structured safe-alternative envelope would need Saranya/shared-contract approval and Lucas's meaning-flow review.

## I. Git and environment status

`arjun` HEAD remains `803379c`. Remote `saranya` HEAD verified using `git ls-remote` and fetch: `13c9f28fb383e486ad1d6e27c522c6054e2892b6`. It is an ancestor of `arjun`; current branch already contains that integrated baseline. The original difference from saranya was two mock-bank files from existing branch history; those files were not edited in this work. No older branch was merged, no rebase/reset occurred, and no new feature checkout was necessary given the explicit instruction to work on arjun.

Seven dirty files are listed in C (one modified tracked compiler file; six new test/evidence/doc files). No commits, pushes or merges. No changed shared interfaces/dependencies. The temporary pnpm shim only affects the testing shell PATH; the system Node 20 default cannot run pnpm 11.19.0. Python-only installs without repository Node/tsx dependencies cannot run the TypeScript consumer boundary test; it fails visibly rather than silently skipping.

## J. Acceptance matrix

| P0 criterion | Status | Evidence / remaining boundary |
|---|---|---|
| Fixed transfer + investment bundle compiles | PASS | A1 exact synthetic fixture |
| Authoritative quantities/fees reconcile | PASS | SGD36825 debit, USD20100 purchase total |
| Customer order and step dependencies | PASS | Forward/reverse and mutation tests |
| Authorized funding and no unnecessary FX | PASS | A2/A3; existing confirmed PREFER_ACCOUNT semantics |
| Minimum balance cannot be bypassed in target | PASS | Global/private scopes and exact/±1-cent boundary |
| Quote validity and tradability | PASS | Missing/expired/disabled cases; evaluated at authoritative snapshot time |
| Cross-goal double spending prevented | PASS | Individually feasible goals fail combined |
| Negative/boundary tests and standalone regressions | PASS | Complete compiler suite 273 passed |
| Compiler HTTP compatibility | PASS | Actual TypeScript parsing, contracts 80 tests/typecheck |
| Deterministic success/refusal handoff | PASS | Exported complete synthetic requests/responses; repeatable exporter |
| No persistent banking state modified | PASS | Pure simulation/TestClient/in-memory API tests |
| Concise evidence report available | PASS | This report + JSON evidence |
| B2 distinct pending/unsettled buckets | PARTIAL | Available/ledger tested; separate buckets absent from contract |
| B7 per-entity customer ownership | PARTIAL | Unknown IDs refuse; ownership not represented; API isolation passed |
| B13 arbitrary stale snapshot detection | PARTIAL | Version/quote/input binding tested; freshness and authoritative caller remain API/bank responsibilities |
| Partial completion described accurately | PASS | Exact prefix states; no rollback; UNKNOWN reconciliation |
| New three-step fixture live/end-to-end execution | NOT TESTED | Saranya integration work; no live ceremony or persistent execution |
| P1 criterion | Status | Evidence / remaining boundary |
| Existing opportunities/replanning assessed | PASS | G lists implemented helpers and HTTP stubs |
| Deterministic authoritative feasibility established | PASS | Five isolated probes |
| Hard protections preserved | PASS | Unchanged reserve; stale/excluded candidates refuse |
| Safe candidate representation or blocker identified | PASS | Existing goals fit revisions; proposal envelope/consent gap documented |
| Fresh confirmation and authorization boundaries | PASS | G/H explicit revised meaning + new exact-plan approval |
| No implicit instruction rewrite / new bypass | PASS | Production alternatives untouched; original remains UNSAT |
| Implementation risk and GO/NO-GO recommendation | PASS | Conditional narrow GO; broad production deferred |
| Saranya review/approval | NOT TESTED / pending | This handoff is supplied for review; no claim that it was sent or approved |
| Production alternatives implementation | NOT TESTED / not authorized | Separate decision; no feature added |
