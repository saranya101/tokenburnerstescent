import { normalizeEntityReference } from "./normalizer.js";
import type { GroundingRawQueryClient } from "./db-types.js";
import type { EntityRepository, GroundableEntityType, GroundingEntity } from "./types.js";

type SupportedDbEntityType = Extract<GroundableEntityType, "BENEFICIARY" | "ASSET">;

interface CanonicalEntityRow {
  readonly ownerUserId: unknown;
  readonly entityType: unknown;
  readonly entityId: unknown;
  readonly canonicalName: unknown;
}

interface AliasEntityRow extends CanonicalEntityRow {
  readonly matchedAlias: unknown;
}

/**
 * User-scoped deterministic repository over the current Prisma schema.
 * Only BENEFICIARY and user-held ASSET have both ownership and a canonical human name.
 */
export class DbEntityRepository implements EntityRepository {
  constructor(
    private readonly client: GroundingRawQueryClient,
    private readonly userId: string,
  ) {
    if (userId.trim().length === 0) throw new Error("DbEntityRepository requires a userId.");
  }

  async findByCanonicalName(normalizedName: string, expectedEntityType?: GroundableEntityType): Promise<readonly GroundingEntity[]> {
    const query = canonicalEntityQuery(expectedEntityType);
    if (query === undefined) return [];
    const rows = await this.client.$queryRawUnsafe<readonly CanonicalEntityRow[]>(query, this.userId);
    const target = normalizeEntityReference(normalizedName);
    return projectRows(rows, this.userId, expectedEntityType)
      .filter((entity) => normalizeEntityReference(entity.canonicalName) === target);
  }

  async findByAlias(normalizedAlias: string, expectedEntityType?: GroundableEntityType): Promise<readonly GroundingEntity[]> {
    const query = aliasEntityQuery(expectedEntityType);
    if (query === undefined) return [];
    const rows = await this.client.$queryRawUnsafe<readonly AliasEntityRow[]>(query, this.userId);
    const target = normalizeEntityReference(normalizedAlias);
    return projectRows(rows.filter((row) =>
      typeof row.matchedAlias === "string" && normalizeEntityReference(row.matchedAlias) === target
    ), this.userId, expectedEntityType, true);
  }
}

function canonicalEntityQuery(expectedEntityType: GroundableEntityType | undefined): string | undefined {
  const branches = canonicalBranches(expectedEntityType);
  return branches.length === 0 ? undefined : `${branches.join("\nUNION ALL\n")}\nORDER BY "entityType" ASC, "entityId" ASC`;
}

function aliasEntityQuery(expectedEntityType: GroundableEntityType | undefined): string | undefined {
  const branches = aliasBranches(expectedEntityType);
  return branches.length === 0 ? undefined : `${branches.join("\nUNION ALL\n")}\nORDER BY "entityType" ASC, "entityId" ASC, "matchedAlias" ASC`;
}

function canonicalBranches(expectedEntityType: GroundableEntityType | undefined): string[] {
  const branches: string[] = [];
  if (expectedEntityType === undefined || expectedEntityType === "BENEFICIARY") {
    branches.push(`SELECT b."userId" AS "ownerUserId", 'BENEFICIARY' AS "entityType", b.id AS "entityId", b.name AS "canonicalName"
FROM "Beneficiary" b
WHERE b."userId" = $1`);
  }
  if (expectedEntityType === undefined || expectedEntityType === "ASSET") {
    branches.push(`SELECT h."userId" AS "ownerUserId", 'ASSET' AS "entityType", a.id AS "entityId", a.name AS "canonicalName"
FROM "Holding" h
JOIN "Asset" a ON a.id = h."assetId"
WHERE h."userId" = $1`);
  }
  return branches;
}

function aliasBranches(expectedEntityType: GroundableEntityType | undefined): string[] {
  const branches: string[] = [];
  if (expectedEntityType === undefined || expectedEntityType === "BENEFICIARY") {
    branches.push(`SELECT ea."userId" AS "ownerUserId", 'BENEFICIARY' AS "entityType", b.id AS "entityId", b.name AS "canonicalName", ea.alias AS "matchedAlias"
FROM "EntityAlias" ea
JOIN "Beneficiary" b ON b.id = ea."entityId" AND b."userId" = ea."userId"
WHERE ea."userId" = $1 AND ea."entityType" = 'BENEFICIARY'`);
  }
  if (expectedEntityType === undefined || expectedEntityType === "ASSET") {
    branches.push(`SELECT ea."userId" AS "ownerUserId", 'ASSET' AS "entityType", a.id AS "entityId", a.name AS "canonicalName", ea.alias AS "matchedAlias"
FROM "EntityAlias" ea
JOIN "Holding" h ON h."assetId" = ea."entityId" AND h."userId" = ea."userId"
JOIN "Asset" a ON a.id = h."assetId"
WHERE ea."userId" = $1 AND ea."entityType" = 'ASSET'`);
  }
  return branches;
}

function projectRows(
  rows: readonly CanonicalEntityRow[],
  userId: string,
  expectedEntityType: GroundableEntityType | undefined,
  includeAlias = false,
): GroundingEntity[] {
  const entities = new Map<string, GroundingEntity>();
  for (const row of rows) {
    if (row.ownerUserId !== userId || !isSupportedType(row.entityType)) continue;
    if (expectedEntityType !== undefined && row.entityType !== expectedEntityType) continue;
    if (typeof row.entityId !== "string" || row.entityId.length === 0) continue;
    if (typeof row.canonicalName !== "string" || row.canonicalName.trim().length === 0) continue;
    const alias = includeAlias && "matchedAlias" in row && typeof row.matchedAlias === "string"
      ? [row.matchedAlias]
      : undefined;
    const key = `${row.entityType}\u0000${row.entityId}`;
    const existing = entities.get(key);
    if (existing === undefined) {
      entities.set(key, {
        entityType: row.entityType,
        entityId: row.entityId,
        canonicalName: row.canonicalName,
        ...(alias === undefined ? {} : { aliases: alias }),
      });
    } else if (alias !== undefined) {
      entities.set(key, { ...existing, aliases: [...new Set([...(existing.aliases ?? []), ...alias])].sort() });
    }
  }
  return [...entities.values()].sort(compareEntities);
}

function isSupportedType(value: unknown): value is SupportedDbEntityType {
  return value === "BENEFICIARY" || value === "ASSET";
}

function compareEntities(left: GroundingEntity, right: GroundingEntity): number {
  return left.entityType.localeCompare(right.entityType) || left.entityId.localeCompare(right.entityId);
}
