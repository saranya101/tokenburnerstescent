# Intent evaluation

B4a provides a provider-independent semantic evaluator for an already-validated `IntentDraftV1`.
It checks only the expected and forbidden semantics declared by each case; it neither invokes a
model nor repairs output. Cases cover happy paths, constraint preservation, entity roles, and
known extraction regressions. Transaction-plan generation is never a desired outcome.

Run the deterministic suite from the repository root:

```bash
pnpm exec vitest run evaluation/intent/evaluator.test.ts
pnpm exec tsc -p evaluation/intent/tsconfig.json --noEmit
```
