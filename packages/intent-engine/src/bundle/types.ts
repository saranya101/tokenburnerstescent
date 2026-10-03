import type { IntentBundleDraftV1, IntentBundleItemDraftV1 } from "@parlance/contracts";
import type { AmbiguityAnalysisResult, ClarificationItem } from "../ambiguity/types.js";
import type { EntityGroundingResult } from "../grounding/types.js";
import type { IntentGroundingRequirement } from "../grounding/requirements.js";

export interface InterpretIntentBundleInput {
  readonly text: string;
  readonly userId: string;
}

export interface IntentBundleModelInput {
  readonly text: string;
  readonly systemPrompt: string;
  readonly promptVersion: string;
}

export interface IntentBundleModelClient {
  generateIntentBundle(input: IntentBundleModelInput): Promise<unknown>;
}

export interface IntentBundleInterpreter {
  interpretUserRequest(input: InterpretIntentBundleInput): Promise<IntentBundleDraftV1>;
}

export type IntentBundleItemIdFactory = (index: number) => string;

export type ClarifiedIntentBundleItem = Omit<IntentBundleItemDraftV1, "itemId">;

export type IntentBundleGroundingRequirement = IntentGroundingRequirement & (
  | { readonly scope: "ITEM"; readonly itemId: string }
  | { readonly scope: "GLOBAL" }
);

export interface IntentBundleItemGroundingResults {
  readonly itemId: string;
  readonly groundingResults: readonly EntityGroundingResult[];
}

export interface IntentBundleAmbiguityAnalysisInput {
  readonly bundle: IntentBundleDraftV1;
  readonly itemGroundingResults: readonly IntentBundleItemGroundingResults[];
  readonly globalGroundingResults: readonly EntityGroundingResult[];
}

export type IntentBundleItemAmbiguityResult = { readonly itemId: string } & AmbiguityAnalysisResult;

export type IntentBundleAmbiguityAnalysisResult =
  | {
      readonly status: "CLEAR";
      readonly items: readonly IntentBundleItemAmbiguityResult[];
      readonly globalClarifications: readonly [];
    }
  | {
      readonly status: "NEEDS_CLARIFICATION";
      readonly items: readonly IntentBundleItemAmbiguityResult[];
      readonly globalClarifications: readonly ClarificationItem[];
    };

export interface IntentBundleAmbiguityDetector {
  analyze(input: IntentBundleAmbiguityAnalysisInput): IntentBundleAmbiguityAnalysisResult;
}
