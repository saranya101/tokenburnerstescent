# Independent read-only intent validation

This boundary re-checks the exact user text or voice transcript against Person B's validated
`IntentDraftV1` and lifecycle-free `GoalContractCandidateV1`. It runs after deterministic grounding
and candidate construction, but before Person A saves or confirms the candidate.

The validator is pure and deterministic. Its only output is `PASS` or `FAIL` plus structured
mismatch reasons. It has no user identity, repository, bank, compiler, approval, planning,
execution, hashing, lifecycle, or persistence capability. It never changes the draft or candidate.

Supported checks include exact source preservation, goal action, explicit money, recipient/asset/
biller/account references and their authoritative semantic roles, source/destination accounts,
unconfirmed binding consistency, supported hard constraints, and supported preferences. Text that
cannot be verified by the deterministic evidence rules fails closed; no model fallback is used.

Person A should proceed to meaning confirmation only when `status === "PASS"`. On `FAIL`, it should
freeze the candidate flow and ask the customer to clarify or re-enter the request. Person A remains
the only owner of binding confirmation and final `GoalContractV1`/hash creation.
