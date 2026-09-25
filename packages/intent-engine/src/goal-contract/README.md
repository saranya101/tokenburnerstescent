# Goal-contract handoff

Human language, semantic candidates, and ambiguity end before this boundary. The builder converts only fully resolved references into canonical IDs and validates `GoalContractV1` before returning it. Downstream planning receives only that canonical contract; it never interprets an `IntentDraftV1` or unresolved grounding state.
