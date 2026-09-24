# Ambiguity analysis

Ambiguity analysis runs before final GoalContractV1 construction. It detects unresolved financial identity from deterministic grounding results and emits structured clarification data. Similarity scores and LLM output are not authorization or identity confirmation. Unresolved references never reach the compiler; Person C receives only a fully grounded GoalContractV1 after orchestration resolves clarification.

Independent clarifications are emitted as a deterministic list in occurrence order: goal fields, constraints, preferences, then explicit `references`. Duplicate reference/type pairs are asked once.

The ambiguity layer answers “what did the customer mean?” It does not decide whether confirmed requirements can be satisfied. A hard constraint wins over an incompatible soft preference, so that combination is not a language clarification. Policy and compiler layers handle feasibility and may disregard incompatible preferences.
