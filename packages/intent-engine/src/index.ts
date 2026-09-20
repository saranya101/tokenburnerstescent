import type { BankStateSnapshotV1, CompilerResultV1, EntityBinding, IntentDraftV1 } from "@parlance/contracts";
export interface FinancialAmbiguityV1 { field: string; reason: string; candidateEntityIds: readonly string[]; }
export interface IntentInterpreter { interpretUserRequest(input: { text: string; userId: string }): Promise<IntentDraftV1>; }
export interface EntityGrounder { groundEntities(draft: IntentDraftV1, candidates: readonly EntityBinding[]): Promise<readonly EntityBinding[]>; }
export interface AmbiguityDetector { detectFinancialAmbiguity(draft: IntentDraftV1, entities: readonly EntityBinding[], state?: BankStateSnapshotV1): Promise<readonly FinancialAmbiguityV1[]>; }
export interface CompilerExplainer { explainCompilerResult(result: CompilerResultV1): Promise<string>; }
export { MockIntentInterpreter } from "./interpreter/mock.js";
