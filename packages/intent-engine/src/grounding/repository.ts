import { normalizeEntityReference } from "./normalizer.js";
import type { EntityRepository, GroundableEntityType, GroundingEntity } from "./types.js";

/** Test/local repository; production persistence can implement EntityRepository later. */
export class InMemoryEntityRepository implements EntityRepository {
  private readonly entities: readonly GroundingEntity[];

  constructor(entities: readonly GroundingEntity[]) {
    this.entities = [...entities];
  }

  findByCanonicalName(normalizedName: string, expectedEntityType?: GroundableEntityType): readonly GroundingEntity[] {
    return this.match(expectedEntityType, (entity) => normalizeEntityReference(entity.canonicalName) === normalizedName);
  }

  findByAlias(normalizedAlias: string, expectedEntityType?: GroundableEntityType): readonly GroundingEntity[] {
    return this.match(expectedEntityType, (entity) => entity.aliases?.some((alias) => normalizeEntityReference(alias) === normalizedAlias) ?? false);
  }

  private match(expectedEntityType: GroundableEntityType | undefined, predicate: (entity: GroundingEntity) => boolean): readonly GroundingEntity[] {
    return this.entities
      .filter((entity) => (expectedEntityType === undefined || entity.entityType === expectedEntityType) && predicate(entity))
      .sort(compareEntities);
  }
}

function compareEntities(left: GroundingEntity, right: GroundingEntity): number {
  return left.entityType.localeCompare(right.entityType) || left.entityId.localeCompare(right.entityId);
}
