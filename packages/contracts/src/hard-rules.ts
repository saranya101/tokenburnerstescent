import { z } from "zod";
import { Id, MoneyV1, SchemaVersionV1 } from "./common.js";

export const HardRule = z.discriminatedUnion("type", [
  z.object({ schemaVersion: SchemaVersionV1, id: Id, userId: Id, type: z.literal("MIN_AVAILABLE_BALANCE"), enabled: z.boolean(), money: MoneyV1, accountId: Id.optional() }).strict(),
  z.object({ schemaVersion: SchemaVersionV1, id: Id, userId: Id, type: z.literal("EXCLUDED_ACCOUNT"), enabled: z.boolean(), accountId: Id }).strict(),
  z.object({ schemaVersion: SchemaVersionV1, id: Id, userId: Id, type: z.literal("MAX_SINGLE_TRANSACTION"), enabled: z.boolean(), money: MoneyV1 }).strict(),
]);
export type HardRule = z.infer<typeof HardRule>;
