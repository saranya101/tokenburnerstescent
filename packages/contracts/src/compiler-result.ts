import { z } from "zod";
import { SchemaVersionV1 } from "./common.js";
import { FinancialPlanV1 } from "./financial-plan.js";

export const CompilerReasonV1 = z.object({ code: z.string().regex(/^[A-Z][A-Z0-9_]*$/), message: z.string().min(1), details: z.record(z.string(), z.unknown()).optional() }).strict();
export const CompilerRelaxationV1 = z.object({ constraintType: z.string().regex(/^[A-Z][A-Z0-9_]*$/), suggestion: z.string().min(1) }).strict();
export const CompilerResultV1 = z.discriminatedUnion("status", [
  z.object({ schemaVersion: SchemaVersionV1, status: z.literal("SAT"), plan: FinancialPlanV1 }).strict(),
  z.object({ schemaVersion: SchemaVersionV1, status: z.literal("UNSAT"), reason: CompilerReasonV1, relaxations: z.array(CompilerRelaxationV1) }).strict(),
  z.object({ schemaVersion: SchemaVersionV1, status: z.literal("POLICY_BLOCKED"), reason: CompilerReasonV1 }).strict(),
]);
export type CompilerResultV1 = z.infer<typeof CompilerResultV1>;
