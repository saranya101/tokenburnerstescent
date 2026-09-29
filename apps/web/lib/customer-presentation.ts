import type { MoneyV1 } from "@parlance/contracts";

export function formatMoney(money: MoneyV1): string {
  const negative = money.minorUnits.startsWith("-"); const digits = negative ? money.minorUnits.slice(1) : money.minorUnits;
  let fractionDigits = 2;
  try { fractionDigits = new Intl.NumberFormat("en", { style: "currency", currency: money.currency }).resolvedOptions().maximumFractionDigits ?? 2; } catch { /* Currency code is still rendered without lossy coercion. */ }
  const padded = digits.padStart(fractionDigits + 1, "0"); const whole = (fractionDigits === 0 ? padded : padded.slice(0, -fractionDigits)).replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
  const fraction = fractionDigits === 0 ? "" : `.${padded.slice(-fractionDigits)}`;
  return `${money.currency} ${negative ? "-" : ""}${whole}${fraction}`;
}
