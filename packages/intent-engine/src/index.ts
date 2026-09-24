import type { BankStateSnapshotV1, CompilerResultV1, EntityBinding, IntentDraftV1 } from "@parlance/contracts";
export type { IntentInterpreter, IntentModelClient, IntentModelInput, InterpretUserRequestInput, IntentValidationIssue } from "./interpreter/types.js";
export { IntentInterpreterError } from "./interpreter/errors.js";
export { ModelBackedIntentInterpreter } from "./interpreter/interpreter.js";
export { INTENT_PROMPT_VERSION } from "./prompts/intent-v1.js";
export { createTokenHubIntentInterpreter, TokenHubIntentModelClient, TokenHubProviderError, loadTokenHubConfig, TokenHubConfigurationError } from "./providers/tokenhub/index.js";
export type { TokenHubConfig } from "./providers/tokenhub/index.js";
export type { EntityGrounder, EntityGroundingInput, EntityGroundingResult, EntityRepository, GroundableEntityType, GroundingCandidate, GroundingEntity, GroundingResolutionMethod } from "./grounding/types.js";
export { DeterministicEntityGrounder } from "./grounding/grounder.js";
export { EntityGroundingError } from "./grounding/errors.js";
export { InMemoryEntityRepository } from "./grounding/repository.js";
export { normalizeEntityReference } from "./grounding/normalizer.js";
export type { SemanticEntityCandidate, SemanticEntityRetriever, SemanticEntityRetrievalInput } from "./retrieval/types.js";
export type { AmbiguityAnalysisResult, AmbiguityReasonCode, ClarificationItem, ClarificationOption, IntentAmbiguityAnalysisInput, IntentAmbiguityDetector } from "./ambiguity/types.js";
export { DeterministicIntentAmbiguityDetector } from "./ambiguity/detector.js";
export type { GoalContractBuildInput, GoalContractBuilder, GoalContractMetadata, GoalContractValidationIssue } from "./goal-contract/types.js";
export { DeterministicGoalContractBuilder } from "./goal-contract/builder.js";
export { GoalContractBuilderError } from "./goal-contract/errors.js";
export interface FinancialAmbiguityV1 { field: string; reason: string; candidateEntityIds: readonly string[]; }
export interface AmbiguityDetector { detectFinancialAmbiguity(draft: IntentDraftV1, entities: readonly EntityBinding[], state?: BankStateSnapshotV1): Promise<readonly FinancialAmbiguityV1[]>; }
export interface CompilerExplainer { explainCompilerResult(result: CompilerResultV1): Promise<string>; }
export { MockIntentInterpreter, MockIntentModelClient } from "./interpreter/mock.js";
