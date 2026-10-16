import type { PrismaClient } from "@parlance/db";
import {
  DeterministicEntityGrounder, InMemoryEntityRepository,
  type EntityGrounder, type EntityGroundingInput, type EntityGroundingResult, type GroundingEntity,
} from "@parlance/intent-engine";

/** Loads only persisted canonical entities and aliases for the submitting user. */
export class PrismaEntityGrounder implements EntityGrounder {
  constructor(private readonly db: PrismaClient, private readonly userId: string) {}

  async eligibleBeneficiaries() {
    const beneficiaries = await this.db.beneficiary.findMany({
      where: { userId: this.userId, status: "ACTIVE", providerRef: { not: null } },
      select: { providerRef: true, name: true },
    });
    return beneficiaries.flatMap((item) => item.providerRef === null ? [] : [{
      entityType: "BENEFICIARY" as const, entityId: item.providerRef, canonicalName: item.name,
    }]);
  }

  async ground(input: EntityGroundingInput): Promise<EntityGroundingResult> {
    const [accounts, beneficiaries, assets, aliases] = await Promise.all([
      this.db.account.findMany({ where: { userId: this.userId, status: "ACTIVE" }, select: { providerRef: true, type: true, currency: true, availableMinorUnits: true } }),
      this.db.beneficiary.findMany({ where: { userId: this.userId, status: "ACTIVE", providerRef: { not: null } }, select: { providerRef: true, name: true } }),
      this.db.asset.findMany({ select: { id: true, name: true, symbol: true } }),
      this.db.entityAlias.findMany({ where: { userId: this.userId }, select: { entityType: true, entityId: true, alias: true } }),
    ]);
    const aliasMap = new Map<string, string[]>();
    for (const alias of aliases) {
      const key = `${alias.entityType}\u0000${alias.entityId}`;
      aliasMap.set(key, [...(aliasMap.get(key) ?? []), alias.alias]);
    }
    const entities: GroundingEntity[] = [
      ...accounts.map((account) => accountEntity(account, aliasMap)),
      ...beneficiaries.flatMap((beneficiary) => beneficiary.providerRef === null ? [] : [entity("BENEFICIARY", beneficiary.providerRef, beneficiary.name, aliasMap)]),
      ...assets.map((asset) => assetEntity(asset, aliasMap)),
    ];
    // An alias is only evidence about a customer-owned account or payee, or an
    // asset already loaded from the authoritative catalogue. It cannot create
    // an entity when its underlying record is absent.
    return new DeterministicEntityGrounder(new InMemoryEntityRepository(entities)).ground(input);
  }
}

function assetEntity(
  asset: { id: string; name: string; symbol: string },
  aliasMap: ReadonlyMap<string, string[]>,
): GroundingEntity {
  const persistedAliases = aliasMap.get(`ASSET\u0000${asset.id}`) ?? [];
  const names = [asset.name, ...persistedAliases];
  return entity("ASSET", asset.id, asset.name, aliasMap, [
    asset.symbol,
    ...names.map((name) => `${name} (${asset.symbol})`),
  ]);
}

function accountEntity(
  account: { providerRef: string; type: string; currency: string; availableMinorUnits: bigint },
  aliasMap: ReadonlyMap<string, string[]>,
): GroundingEntity {
  const aliases = aliasMap.get(`ACCOUNT\u0000${account.providerRef}`) ?? [];
  const canonicalName = preferredAccountName(aliases, account.currency, account.type);
  return {
    entityType: "ACCOUNT", entityId: account.providerRef, canonicalName,
    aliases: [...new Set([account.providerRef, ...aliases])],
    account: { currency: account.currency, accountType: account.type, availableMinorUnits: account.availableMinorUnits.toString() },
  };
}

function preferredAccountName(aliases: readonly string[], currency: string, type: string): string {
  const generic = new RegExp(`^(?:my\\s+)?${currency}\\s+account$`, "iu");
  const named = aliases.filter((alias) => !generic.test(alias.trim())).sort((left, right) => left.localeCompare(right))[0];
  if (named !== undefined) return named;
  const label = type.toLowerCase().replace(/(^|_)([a-z])/gu, (_match, prefix: string, letter: string) => `${prefix ? " " : ""}${letter.toUpperCase()}`);
  return `${currency} ${label} account`;
}

function entity(
  entityType: GroundingEntity["entityType"], entityId: string, canonicalName: string,
  aliasMap: ReadonlyMap<string, string[]>, extraAliases: readonly string[] = [],
): GroundingEntity {
  return { entityType, entityId, canonicalName, aliases: [...extraAliases, ...(aliasMap.get(`${entityType}\u0000${entityId}`) ?? [])] };
}
