import { Redis } from "ioredis";
export function createEphemeralRedis() { return new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", { lazyConnect: true, maxRetriesPerRequest: 1 }); }
