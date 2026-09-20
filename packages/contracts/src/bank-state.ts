import { z } from "zod";
import { CurrencyCode, Id, IsoTimestamp, MoneyV1, NonNegativeDecimalString, NonNegativeMinorUnits, SchemaVersionV1 } from "./common.js";

export const AccountV1 = z.object({
  id: Id, type: z.enum(["CHECKING", "SAVINGS", "BROKERAGE", "WALLET"]), currency: CurrencyCode,
  ledgerMinorUnits: NonNegativeMinorUnits, availableMinorUnits: NonNegativeMinorUnits,
  status: z.enum(["ACTIVE", "FROZEN", "CLOSED"]),
  capabilities: z.array(z.enum(["SEND_TRANSFER", "RECEIVE_TRANSFER", "CONVERT_FX", "PAY_BILL", "TRADE_ASSET"])),
}).strict();
export const BeneficiaryV1 = z.object({ id: Id, name: z.string().min(1), supportedCurrencies: z.array(CurrencyCode), status: z.enum(["ACTIVE", "BLOCKED", "PENDING_VERIFICATION"]) }).strict();
export const AssetV1 = z.object({ id: Id, symbol: z.string().min(1), name: z.string().min(1), assetType: z.enum(["EQUITY", "ETF", "BOND", "FUND", "CRYPTO", "OTHER"]), tradable: z.boolean(), settlementCurrency: CurrencyCode }).strict();
export const HoldingV1 = z.object({ assetId: Id, quantity: NonNegativeDecimalString }).strict();
export const ObligationV1 = z.object({ id: Id, description: z.string().min(1), money: MoneyV1, dueAt: IsoTimestamp, status: z.enum(["OPEN", "PAID", "OVERDUE", "CANCELLED"]) }).strict();
export const ServiceAvailabilityV1 = z.object({ transfers: z.boolean(), fx: z.boolean(), billPayments: z.boolean(), investments: z.boolean() }).strict();
export const FxQuoteV1 = z.object({ id: Id, fromCurrency: CurrencyCode, toCurrency: CurrencyCode, rate: NonNegativeDecimalString, fee: MoneyV1.optional(), expiresAt: IsoTimestamp }).strict();

export const BankStateSnapshotV1 = z.object({
  schemaVersion: SchemaVersionV1, userId: Id, stateVersion: z.number().int().nonnegative(), capturedAt: IsoTimestamp,
  accounts: z.array(AccountV1), beneficiaries: z.array(BeneficiaryV1), assets: z.array(AssetV1), holdings: z.array(HoldingV1),
  obligations: z.array(ObligationV1), serviceAvailability: ServiceAvailabilityV1, fxQuotes: z.array(FxQuoteV1),
}).strict();
export type BankStateSnapshotV1 = z.infer<typeof BankStateSnapshotV1>;
