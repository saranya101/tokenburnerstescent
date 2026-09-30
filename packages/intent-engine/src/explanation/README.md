# Deterministic explanations

This layer renders validated Person B and shared contracts into traceable user-facing statements.
It does not call a model, plan operations, infer missing facts, interpret compiler reason details, or
claim execution from a plan. Canonical IDs are used only to look up an existing `EntityBinding` and
are never rendered; when no unique human reference is available, role-based wording is used.
Compiler reason messages and relaxation suggestions remain authoritative, but known/internal
identifier tokens are deterministically redacted before rendering. Structured compiler `details`
are never copied into prose.

Shared Contract V1 exposes compiler `SAT`, `UNSAT`, and `POLICY_BLOCKED` results, including reason
messages and optional compiler-provided relaxation suggestions. Preflight, revalidation, and C5's
richer feasibility evidence are currently compiler-internal Python dataclasses, not shared
contracts, so they are deliberately outside this package's public explanation input.
