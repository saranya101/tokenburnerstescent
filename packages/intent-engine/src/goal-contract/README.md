# Goal-contract handoff

Human language, semantic candidates, and ambiguity end before this boundary. The builder converts only fully resolved references into canonical IDs and validates `GoalContractV1` before returning it. Downstream planning receives only that canonical contract; it never interprets an `IntentDraftV1` or unresolved grounding state.

Entity bindings retain the exact original human reference for audit and user-facing explanation.
The in-memory contract can represent the same phrase under two genuine semantic roles. The current
Prisma `GoalEntityBinding` uniqueness rule covers only `(goalContractId, reference)`, so persisting
that edge case losslessly remains a DB-schema follow-up outside Person B.
