# Ambiguity analysis

Ambiguity analysis runs before final GoalContractV1 construction. It detects unresolved financial identity from deterministic grounding results and emits structured clarification data. Similarity scores and LLM output are not authorization or identity confirmation. Unresolved references never reach the compiler; Person C receives only a fully grounded GoalContractV1 after orchestration resolves clarification.

Independent clarifications are emitted as a deterministic list in occurrence order: goal fields,
constraints, preferences, then unrelated supplemental `references`. Goal, constraint, and
preference fields define the authoritative semantic role. A supplemental reference whose
normalized text matches one of those fields is ignored even when its optional type metadata is
missing, matching, or contradictory. The same text is still preserved separately when it is
genuinely used by two semantic fields with different roles.

The ambiguity layer answers “what did the customer mean?” It does not decide whether confirmed requirements can be satisfied. A hard constraint wins over an incompatible soft preference, so that combination is not a language clarification. Policy and compiler layers handle feasibility and may disregard incompatible preferences.
