# Person B multi-intent parsing

`ModelBackedIntentBundleInterpreter` returns the frozen shared `IntentBundleDraftV1` shape. It does
not replace the existing single-intent interpreter. Application code assigns stable item IDs and
remaps explicit dependency endpoints before strict shared-schema validation.

Plain `and` preserves item array order but creates no dependency. Only explicit customer ordering
such as `then`, `after`, or `before` may produce `USER_EXPLICIT_ORDER` edges.

`groundingRequirementsForIntentBundle` keeps grounding work scoped to an item or to a global
constraint. `DeterministicIntentBundleAmbiguityDetector` evaluates every item independently, so one
ambiguous item does not invalidate, regenerate, or remove clear siblings.

`replaceClarifiedIntentBundleItem` replaces one item's semantic payload while preserving its ID,
array position, all other items, global constraints, and explicit dependencies. The caller should
send only that item's relevant text and clarification to any model used for re-interpretation.

`DeterministicIntentBundleCoverageValidator` independently checks supported source-language goal
coverage, explicit ordering, and trailing unscoped global balance constraints. Missing and extra
goals fail closed before Person A confirmation. It has no planning, approval, persistence,
compiler, or execution authority.
