# Adversarial evaluation

B4b exercises the `IntentDraftV1` trust boundary with prompt injection, action smuggling,
role confusion, constraint overrides, structured-output attacks, and messy human input.
It evaluates supplied candidates deterministically: no model or provider is called.

Runtime objects are first inspected for executable/authority structures and then parsed with the
strict `IntentDraftV1` Zod contract. Valid drafts reuse the B4a semantic evaluator. Text inside
`originalText` is never interpreted as a trusted field, operation, approval, or canonical ID.

Run the deterministic suite from the repository root:

```bash
pnpm exec vitest run evaluation/adversarial/evaluator.test.ts
pnpm exec tsc -p evaluation/adversarial/tsconfig.json --noEmit
```
