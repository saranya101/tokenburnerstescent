# Person B: language intelligence

`@parlance/intent-engine` translates user language into an untrusted `IntentDraftV1`, grounds its
human references, identifies ambiguity, builds a lifecycle-free `GoalContractCandidateV1`, and renders
deterministic explanations. It does not create financial-plan steps, approve anything, execute
bank operations, or write to a bank.

The separate `ModelBackedIntentBundleInterpreter` parses multi-goal language into the frozen
`IntentBundleDraftV1` contract while the original single-intent API remains unchanged. Bundle item
IDs are application-owned, plain `and` never creates a dependency, and ambiguity/clarification stays
isolated per item.

## Trust boundaries and data flow

```text
user text
  -> TokenHub transport DTO
  -> deterministic transport projection
  -> IntentDraftV1 validation
  -> grounding requirements
  -> exact / alias resolution or semantic candidates
  -> ambiguity gate
  -> lifecycle-free GoalContractCandidateV1
  -> independent read-only intent validation
  -> Person A confirmation and canonical GoalContractV1
  -> deterministic explanation
```

- TokenHub receives only the versioned system prompt and the current user text. User IDs, account
  numbers, balances, provider references, canonical IDs, holdings, bank state, plan hashes,
  approvals, execution data, and DB rows are not model inputs.
- `IntentDraftV1.safeParse()` is the final model-output trust boundary. `originalText` is attached
  exactly by application code after generation. Model output cannot contain financial actions,
  plans, approvals, or execution authority.
- Goal, constraint, and preference fields retain human references at the intent stage. Their
  semantic field roles are authoritative; contradictory supplemental `references` metadata cannot
  override them or create duplicate grounding work.
- Exact canonical-name matches resolve first, followed by exact alias matches. Multiple exact or
  alias matches are ambiguous. Semantic retrieval runs only when explicitly requested after both
  deterministic stages miss; it returns `CANDIDATES` and never auto-resolves identity.
- Only fully resolved canonical IDs enter `GoalContractCandidateV1`. Its bindings remain
  unconfirmed, and it contains no ID, user ID, version, status, hash, timestamps, or persistence
  metadata. Person A alone confirms the candidate and creates the canonical `GoalContractV1`.
  Ambiguous, missing, and semantic candidate results stay in Person B/orchestration.
- `DeterministicReadOnlyIntentValidator` independently compares the exact source text, validated
  draft, and candidate. It returns only `PASS`/`FAIL` with structured mismatch reasons and has no
  authority or dependency capable of mutation, confirmation, planning, approval, persistence, or
  execution. A failure must stop the candidate before Person A confirmation.
- Explanations are pure deterministic rendering of validated goals, plans, compiler results, or
  execution results. They do not call an LLM, add operations or reasons, or expose internal IDs
  when a human label is available.

## Public integration surface

Person A should compose through the package root:

- `createTokenHubIntentInterpreter()` for language interpretation;
- `createTokenHubIntentBundleInterpreter()` for the frozen multi-intent bundle shape;
- `groundingRequirementsForIntentBundle()` and `DeterministicIntentBundleAmbiguityDetector` for
  item-scoped grounding and clarification;
- `replaceClarifiedIntentBundleItem()` for targeted clarification without regenerating siblings;
- `DeterministicIntentBundleCoverageValidator` for missing/extra goal and explicit-order checks;
- `createDbGroundingStack()` for user-scoped DB exact/alias and pgvector candidate retrieval;
- `groundingRequirementsForIntent()` to derive authoritative grounding work;
- `DeterministicIntentAmbiguityDetector` for the pre-contract clarification gate;
- `DeterministicGoalContractBuilder` for the lifecycle-free canonical-ID candidate handoff;
- `DeterministicReadOnlyIntentValidator` immediately after candidate construction and before
  Person A stores or confirms it;
- `DeterministicExplanationRenderer` and `renderExplanationText()` for deterministic prose.

The package also exports provider-neutral interfaces and in-memory implementations for dependency
injection and deterministic tests. Provider transport projection, direct TokenHub client classes,
and development diagnostics are intentionally not exported from the package root.

## TokenHub configuration

Local and benchmark configuration should explicitly use:

```ini
TOKENHUB_MODEL="hy3"
TOKENHUB_THINKING="disabled"
```

`TOKENHUB_API_KEY` is required only for opt-in live calls and must never be committed. Normal tests,
typechecks, and builds do not call TokenHub. The client timeout remains 60 seconds pending broader
production latency evidence.

## Current DB limitations

- `Account` has no canonical human label, so DB-backed `ACCOUNT` grounding fails closed rather than
  exposing `providerRef` as a label.
- There are no canonical `BILLER` or `OBLIGATION` models, so those types also fail closed.
- DB-backed `ASSET` grounding is scoped through the user's `Holding`; this represents held assets,
  not a complete catalog of assets that could be acquired.
- Embedding generation is an injected `SemanticReferenceEmbedder`; no production embedding
  provider is selected by this package.
- The pgvector cosine query is implemented, but a production vector index and its deployment plan
  remain an operational follow-up.
- `GoalEntityBinding` currently has `@@unique([goalContractId, reference])`. A valid contract can
  preserve the same text in two distinct semantic roles, so persistence needs a future uniqueness
  change before that edge case can be stored losslessly.

## Evaluation evidence

The opt-in 40-case TokenHub benchmark completed on 2026-09-29 with `hy3` and thinking disabled:

- semantic: 19 / 19;
- adversarial: 21 / 21;
- overall: 40 / 40;
- all safety counters: 0;
- provider/model errors: 0;
- median latency: approximately 3.3 seconds;
- p95 latency: approximately 3.745 seconds.

These are results from that specific synthetic benchmark run, not universal correctness, safety,
availability, or latency guarantees.
