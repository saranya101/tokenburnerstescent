import { z } from "zod";

export const SchemaVersionV1 = z.literal("1");
export const Id = z.string().min(1);
export const IsoTimestamp = z.string().datetime({ offset: true });
export const CurrencyCode = z.string().regex(/^[A-Z]{3}$/);
export const MinorUnits = z.string().regex(/^-?(0|[1-9]\d*)$/);
export const NonNegativeMinorUnits = z.string().regex(/^(0|[1-9]\d*)$/);
export const DecimalString = z.string().regex(/^-?(0|[1-9]\d*)(\.\d+)?$/);
export const NonNegativeDecimalString = z.string().regex(/^(0|[1-9]\d*)(\.\d+)?$/);
export const Hash = z.string().min(16);

export const MoneyV1 = z.object({
  currency: CurrencyCode,
  minorUnits: MinorUnits,
}).strict();
export type MoneyV1 = z.infer<typeof MoneyV1>;
