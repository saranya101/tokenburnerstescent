# Opt-in TokenHub intent benchmark

This runner calls the public `createTokenHubIntentInterpreter()` factory sequentially and evaluates
the returned, validated `IntentDraftV1` values against B4a and B4b. It is not part of normal test,
build, typecheck, or CI commands.

```bash
# All 40 fixtures
TOKENHUB_MODEL=hy3 TOKENHUB_THINKING=disabled pnpm eval:intent:live -- all

# One dataset
TOKENHUB_MODEL=hy3 TOKENHUB_THINKING=disabled pnpm eval:intent:live -- semantic
TOKENHUB_MODEL=hy3 TOKENHUB_THINKING=disabled pnpm eval:intent:live -- adversarial

# One fixture
TOKENHUB_MODEL=hy3 TOKENHUB_THINKING=disabled pnpm eval:intent:live -- constraint-ignore-limit

# Optional report location, resolved from the repository root
pnpm eval:intent:live -- semantic --output evaluation/results/my-tokenhub-report.json
```

`TOKENHUB_API_KEY` must already be present in the process environment. Generated default reports
use `evaluation/results/tokenhub-intent-<timestamp>.json` and are gitignored. Reports contain the
model, thinking mode, prompt version, selection, per-case outcomes, aggregates, and durations—but
never the API key, headers, raw provider response, or complete environment.

Metric definitions are deterministic:

- pass rates count fixture-level PASS results in each selected dataset;
- safety values count affected cases, not the number of repeated findings in a case;
- invented/missing constraints come from failed B4a constraint assertion IDs;
- provider/model errors are sanitized interpreter failures;
- latency covers every attempted case, uses rounded milliseconds, the conventional midpoint
  median, and nearest-rank p95 (`ceil(0.95 * n)`).

Test the runner without network access:

```bash
pnpm exec vitest run evaluation/intent-live/runner.test.ts
pnpm exec tsc -p evaluation/intent-live/tsconfig.json --noEmit
```

## Recorded 40-case run

The complete synthetic benchmark run generated at `2026-09-29T07:29:47.907Z`, using TokenHub
`hy3` with thinking disabled, recorded:

- semantic: 19 / 19;
- adversarial: 21 / 21;
- overall: 40 / 40;
- all safety counters: 0;
- provider/model errors: 0;
- median latency: 3,300.5 ms (approximately 3.3 seconds);
- p95 latency: 3,745 ms (approximately 3.745 seconds).

These numbers describe that one fixture set and run. They are evaluation evidence, not universal
correctness, safety, availability, or latency guarantees.
