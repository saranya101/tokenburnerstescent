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

  findBySemanticEvidence(normalizedReference: string, expectedEntityType?: GroundableEntityType): readonly GroundingEntity[] {
    if (expectedEntityType !== undefined && expectedEntityType !== "ACCOUNT") return [];
    return this.match("ACCOUNT", (entity) => accountMatches(entity, normalizedReference));
  }

  private match(expectedEntityType: GroundableEntityType | undefined, predicate: (entity: GroundingEntity) => boolean): readonly GroundingEntity[] {
    return this.entities
      .filter((entity) => (expectedEntityType === undefined || entity.entityType === expectedEntityType) && predicate(entity))
      .sort(compareEntities);
  }
}

const ignoredAccountWords = new Set(["my", "the", "account", "accounts", "use", "from", "for", "rest", "shortfall", "money"]);
const currencyWords = new Set(["sgd", "usd", "eur", "gbp", "jpy", "aud", "cad", "chf", "cny", "hkd", "inr"]);

function accountMatches(entity: GroundingEntity, normalizedReference: string): boolean {
  if (entity.entityType !== "ACCOUNT" || entity.account === undefined) return false;
  const words = normalizedReference.split(" ").filter(Boolean);
  const currency = entity.account.currency.toLowerCase();
  const mentionedCurrencies = words.filter((word) => currencyWords.has(word));
  if (mentionedCurrencies.length > 0 && !mentionedCurrencies.includes(currency)) return false;

  const searchable = normalizeEntityReference([entity.canonicalName, ...(entity.aliases ?? []), entity.account.accountType].join(" "));
  const meaningful = words.filter((word) => !ignoredAccountWords.has(word) && word !== currency);
  if (meaningful.length === 0) return mentionedCurrencies.length > 0;
  return meaningful.every((word) => searchable.split(" ").includes(word));
}

function compareEntities(left: GroundingEntity, right: GroundingEntity): number {
  return left.entityType.localeCompare(right.entityType) || left.entityId.localeCompare(right.entityId);
}
