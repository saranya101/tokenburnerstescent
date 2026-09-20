import { Queue } from "bullmq";
import { Redis } from "ioredis";
export const queueNames = ["reconciliation", "opportunity-recalculation", "embedding-generation", "notifications", "outbox-publishing"] as const;
export type QueueName = (typeof queueNames)[number];
export function createQueues(redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379") {
  const connection = new Redis(redisUrl, { maxRetriesPerRequest: null, lazyConnect: true });
  return { connection, queues: Object.fromEntries(queueNames.map((name) => [name, new Queue(name, { connection, defaultJobOptions: { attempts: 5, backoff: { type: "exponential", delay: 1000 }, removeOnComplete: 100, removeOnFail: false } })])) as Record<QueueName, Queue> };
}
