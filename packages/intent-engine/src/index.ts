import type { BankStateSnapshotV1, CompilerResultV1, EntityBinding, IntentDraftV1 } from "@parlance/contracts";
export type { IntentInterpreter, IntentModelClient, IntentModelInput, InterpretUserRequestInput, IntentValidationIssue } from "./interpreter/types.js";
export { IntentInterpreterError } from "./interpreter/errors.js";
export { ModelBackedIntentInterpreter } from "./interpreter/interpreter.js";
export { INTENT_PROMPT_VERSION } from "./prompts/intent-v1.js";
export interface FinancialAmbiguityV1 { field: string; reason: string; candidateEntityIds: readonly string[]; }
export interface EntityGrounder { groundEntities(draft: IntentDraftV1, candidates: readonly EntityBinding[]): Promise<readonly EntityBinding[]>; }
export interface AmbiguityDetector { detectFinancialAmbiguity(draft: IntentDraftV1, entities: readonly EntityBinding[], state?: BankStateSnapshotV1): Promise<readonly FinancialAmbiguityV1[]>; }
export interface CompilerExplainer { explainCompilerResult(result: CompilerResultV1): Promise<string>; }
export { MockIntentInterpreter, MockIntentModelClient } from "./interpreter/mock.js";
