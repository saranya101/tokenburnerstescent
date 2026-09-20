import { z } from "zod";
import { Hash, Id, IsoTimestamp, SchemaVersionV1 } from "./common.js";

export const ApprovalV1 = z.object({
  schemaVersion: SchemaVersionV1, id: Id, userId: Id, goalContractId: Id, goalContractVersion: z.number().int().positive(),
  goalContractHash: Hash, financialPlanId: Id, financialPlanHash: Hash, bankStateVersion: z.number().int().nonnegative(),
  method: z.enum(["BIOMETRIC", "PASSKEY", "PIN", "EXTERNAL_SIGNATURE"]), approvedAt: IsoTimestamp, expiresAt: IsoTimestamp, signatureReference: Id,
}).strict();
export type ApprovalV1 = z.infer<typeof ApprovalV1>;
