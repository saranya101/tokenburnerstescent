import type { PrismaClient } from "@parlance/db";
import {
  DeterministicEntityGrounder, InMemoryEntityRepository,
  type EntityGrounder, type EntityGroundingInput, type EntityGroundingResult, type GroundingEntity,
} from "@parlance/intent-engine";

/** Loads only persisted canonical entities and aliases for the submitting user. */
export class PrismaEntityGrounder implements EntityGrounder {
  constructor(private readonly db: PrismaClient, private readonly userId: string) {}

  async ground(input: EntityGroundingInput): Promise<EntityGroundingResult> {
    const [accounts, beneficiaries, assets, aliases] = await Promise.all([
      this.db.account.findMany({ where: { userId: this.userId }, select: { id: true, providerRef: true } }),
      this.db.beneficiary.findMany({ where: { userId: this.userId, providerRef: { not: null } }, select: { providerRef: true, name: true } }),
      this.db.asset.findMany({ select: { id: true, name: true, symbol: true } }),
      this.db.entityAlias.findMany({ where: { userId: this.userId }, select: { entityType: true, entityId: true, alias: true } }),
    ]);
    const aliasMap = new Map<string, string[]>();
    for (const alias of aliases) {
      const key = `${alias.entityType}\u0000${alias.entityId}`;
      aliasMap.set(key, [...(aliasMap.get(key) ?? []), alias.alias]);
    }
    const entities: GroundingEntity[] = [
      ...accounts.map((account) => entity("ACCOUNT", account.providerRef, account.providerRef, aliasMap)),
      ...beneficiaries.flatMap((beneficiary) => beneficiary.providerRef === null ? [] : [entity("BENEFICIARY", beneficiary.providerRef, beneficiary.name, aliasMap)]),
      ...assets.map((asset) => entity("ASSET", asset.id, asset.name, aliasMap, [asset.symbol])),
    ];
    for (const alias of aliases) {
      if (entities.some((item) => item.entityType === alias.entityType && item.entityId === alias.entityId)) continue;
      entities.push(entity(alias.entityType as GroundingEntity["entityType"], alias.entityId, alias.alias, aliasMap));
    }
    return new DeterministicEntityGrounder(new InMemoryEntityRepository(entities)).ground(input);
  }
}

function entity(
  entityType: GroundingEntity["entityType"], entityId: string, canonicalName: string,
  aliasMap: ReadonlyMap<string, string[]>, extraAliases: readonly string[] = [],
): GroundingEntity {
  return { entityType, entityId, canonicalName, aliases: [...extraAliases, ...(aliasMap.get(`${entityType}\u0000${entityId}`) ?? [])] };
}
