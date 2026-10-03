import type { BankStateSnapshotV1 } from "@parlance/contracts";

const currencyPrefix: Readonly<Record<string, string>> = { SGD: "S$", USD: "US$" };

export function formatMinorUnits(currency: string, minorUnits: string | bigint): string {
  const value = typeof minorUnits === "bigint" ? minorUnits : BigInt(minorUnits);
  const negative = value < 0n; const absolute = negative ? -value : value;
  const major = (absolute / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
  const minor = (absolute % 100n).toString().padStart(2, "0");
  return `${negative ? "−" : ""}${currencyPrefix[currency] ?? `${currency} `}${major}.${minor}`;
}

export function accountLabel(account: BankStateSnapshotV1["accounts"][number]): string {
  if (account.id === "acc-sgd") return "SGD Account";
  if (account.id === "acc-usd") return "USD Account";
  const type = account.type.toLocaleLowerCase().replace(/^./u, (letter) => letter.toLocaleUpperCase());
  return `${account.currency} ${type}`;
}

export function capabilityLabel(capability: string): string {
  const labels: Readonly<Record<string, string>> = {
    SEND_TRANSFER: "Send transfers", RECEIVE_TRANSFER: "Receive transfers", CONVERT_FX: "Convert currency",
    PAY_BILL: "Pay bills", TRADE_ASSET: "Trade investments",
  };
  return labels[capability] ?? capability.toLocaleLowerCase().replaceAll("_", " ");
}

export function estimatedHoldingValueMinorUnits(quantity: string, unitPriceMinor: string): bigint {
  const match = /^(0|[1-9]\d*)(?:\.(\d+))?$/u.exec(quantity);
  if (!match) throw new Error("INVALID_HOLDING_QUANTITY");
  const fraction = match[2] ?? ""; const denominator = 10n ** BigInt(fraction.length);
  const product = BigInt(`${match[1]}${fraction}`) * BigInt(unitPriceMinor);
  const quotient = product / denominator; const remainder = product % denominator; const doubled = remainder * 2n;
  return doubled > denominator || (doubled === denominator && quotient % 2n !== 0n) ? quotient + 1n : quotient;
}

export function balancesByCurrency(state: BankStateSnapshotV1): Array<{ currency: string; availableMinorUnits: bigint }> {
  const totals = new Map<string, bigint>();
  for (const account of state.accounts) {
    if (account.status === "ACTIVE") totals.set(account.currency, (totals.get(account.currency) ?? 0n) + BigInt(account.availableMinorUnits));
  }
  return [...totals].sort(([left], [right]) => left.localeCompare(right)).map(([currency, availableMinorUnits]) => ({ currency, availableMinorUnits }));
}
