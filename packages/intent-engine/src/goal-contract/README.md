# Goal-contract handoff

Human language, semantic candidates, and ambiguity end before this boundary. The builder converts
only fully resolved references into canonical IDs and validates a lifecycle-free
`GoalContractCandidateV1` before returning it to Person A. All bindings remain unconfirmed. The
candidate contains no contract ID, user ID, version, status, hash, timestamps, or persistence
metadata. Person A alone handles explicit confirmation and creates the canonical confirmed
`GoalContractV1` for downstream planning.

Entity bindings retain the exact original human reference for audit and user-facing explanation.
The in-memory contract can represent the same phrase under two genuine semantic roles. The current
Prisma `GoalEntityBinding` uniqueness rule covers only `(goalContractId, reference)`, so persisting
that edge case losslessly remains a DB-schema follow-up outside Person B.
