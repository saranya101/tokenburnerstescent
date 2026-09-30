/** Minimal structural port implemented by PrismaClient without importing or owning its lifecycle. */
export interface GroundingRawQueryClient {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
}
