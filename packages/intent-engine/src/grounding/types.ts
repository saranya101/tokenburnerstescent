import type { EntityBinding } from "@parlance/contracts";
import type { SemanticEntityCandidate } from "../retrieval/types.js";

export type GroundableEntityType = EntityBinding["entityType"];
export type GroundingResolutionMethod = Extract<EntityBinding["resolutionMethod"], "EXACT" | "ALIAS">;

export interface EntityGroundingInput {
  reference: string;
  expectedEntityType?: GroundableEntityType;
  /** Opt in to semantic candidate discovery after deterministic matching misses. */
  semanticSearch?: { limit?: number };
}

/** A known entity supplied by an integration-owned repository. */
export interface GroundingEntity {
  entityType: GroundableEntityType;
  entityId: string;
  canonicalName: string;
  aliases?: readonly string[];
}

export interface GroundingCandidate {
  entityType: GroundableEntityType;
  entityId: string;
  canonicalName: string;
}

export type EntityGroundingResult =
  | { status: "RESOLVED"; reference: string; entityType: GroundableEntityType; entityId: string; resolutionMethod: GroundingResolutionMethod }
  | { status: "AMBIGUOUS"; reference: string; expectedEntityType?: GroundableEntityType; candidates: readonly GroundingCandidate[] }
  | { status: "CANDIDATES"; reference: string; expectedEntityType?: GroundableEntityType; candidates: readonly SemanticEntityCandidate[] }
  | { status: "NOT_FOUND"; reference: string; expectedEntityType?: GroundableEntityType };

export interface EntityRepository {
  findByCanonicalName(normalizedName: string, expectedEntityType?: GroundableEntityType): readonly GroundingEntity[];
  findByAlias(normalizedAlias: string, expectedEntityType?: GroundableEntityType): readonly GroundingEntity[];
}

export interface EntityGrounder {
  ground(input: EntityGroundingInput): Promise<EntityGroundingResult>;
}
