import { z } from "zod";
import { IsoTimestamp, MoneyV1 } from "./common.js";

export const CustomerActivityItemV1 = z.object({
  occurredAt: IsoTimestamp,
  description: z.string().min(1),
  accountLabel: z.string().min(1),
  amount: MoneyV1,
  direction: z.literal("DEBIT"),
  status: z.literal("COMPLETED"),
}).strict();
export type CustomerActivityItemV1 = z.infer<typeof CustomerActivityItemV1>;

export const CustomerActivityV1 = z.object({ items: z.array(CustomerActivityItemV1).max(10) }).strict();
export type CustomerActivityV1 = z.infer<typeof CustomerActivityV1>;
