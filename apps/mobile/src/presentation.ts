import type { BankState } from "./api";

export function money(currency: string, minor: string): string {
  const amount = BigInt(minor); const abs = amount < 0n ? -amount : amount;
  const whole = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
  return `${amount < 0n ? "−" : ""}${currency === "SGD" ? "S$" : currency === "USD" ? "US$" : `${currency} `}${whole}.${(abs % 100n).toString().padStart(2, "0")}`;
}

export function holdingValue(quantity: string, unitPriceMinor: string): string {
  const [whole = "0", fraction = ""] = quantity.split(".");
  const scaled = BigInt(`${whole}${fraction}`) * BigInt(unitPriceMinor);
  const denominator = 10n ** BigInt(fraction.length);
  const quotient = scaled / denominator; const remainder = scaled % denominator;
  return (quotient + (remainder * 2n > denominator || (remainder * 2n === denominator && quotient % 2n !== 0n) ? 1n : 0n)).toString();
}

export function quotedPortfolioValues(
  holdings: readonly { assetId: string; quantity: string }[],
  quotes: readonly { assetId: string; settlementCurrency: string; unitPriceMinor: string; expiresAt: string }[],
  now: number,
): Array<{ currency: string; minorUnits: string }> {
  const totals = new Map<string, bigint>();
  for (const holding of holdings) {
    const quote = quotes.find((item) => item.assetId === holding.assetId && Date.parse(item.expiresAt) > now);
    if (!quote) return [];
    totals.set(quote.settlementCurrency, (totals.get(quote.settlementCurrency) ?? 0n) + BigInt(holdingValue(holding.quantity, quote.unitPriceMinor)));
  }
  return [...totals].map(([currency, amount]) => ({ currency, minorUnits: amount.toString() }));
}

export function sgdReserveMinorUnits(input: string): string | undefined {
  const value = input.trim().replaceAll(",", "");
  if (!/^(0|[1-9]\d*)(?:\.\d{1,2})?$/u.test(value)) return;
  const [major, cents = ""] = value.split(".");
  return (BigInt(major!) * 100n + BigInt(cents.padEnd(2, "0"))).toString();
}

export function describeCandidate(value: unknown, state?: Pick<BankState, "accounts" | "beneficiaries" | "assets">): string[] {
  const label = (reference: unknown, id: unknown, fallback: string): string => {
    const payee = state?.beneficiaries.find((item) => item.id === id); if (payee) return payee.name;
    const asset = state?.assets.find((item) => item.id === id); if (asset) return asset.name;
    const account = state?.accounts.find((item) => item.id === id); if (account) return `${account.currency} ${account.type.toLowerCase()}`;
    return typeof reference === "string" ? reference : fallback;
  };
  if (!value || typeof value !== "object") return ["Review your requested action"];
  const candidate = value as Record<string, unknown>;
  const items = Array.isArray(candidate.items) ? candidate.items : [candidate];
  const lines = items.map((item, index) => {
    const goal = item && typeof item === "object" ? (item as Record<string, unknown>).goal : undefined;
    return `${items.length > 1 ? `${index + 1}. ` : ""}${describeGoal(goal, label)}`;
  });
  const terms = [...(Array.isArray(candidate.constraints) ? candidate.constraints : []), ...(Array.isArray(candidate.globalConstraints) ? candidate.globalConstraints : []),
    ...(Array.isArray(candidate.items) ? items : []).flatMap((item) => item && typeof item === "object" && Array.isArray((item as Record<string, unknown>).constraints) ? (item as { constraints: unknown[] }).constraints : [])];
  for (const term of terms) {
    if (!term || typeof term !== "object") continue;
    const constraint = term as Record<string, unknown>; const amount = constraint.money;
    if (constraint.type !== "MIN_AVAILABLE_BALANCE" || !amount || typeof amount !== "object") continue;
    const value = amount as Record<string, unknown>;
    if (typeof value.currency === "string" && typeof value.minorUnits === "string") lines.push(`Keep at least ${money(value.currency, value.minorUnits)} available in ${label(constraint.accountReference, constraint.accountId, "the selected account")}`);
  }
  const preferences = [...(Array.isArray(candidate.preferences) ? candidate.preferences : []),
    ...(Array.isArray(candidate.items) ? items : []).flatMap((item) => item && typeof item === "object" && Array.isArray((item as Record<string, unknown>).preferences) ? (item as { preferences: unknown[] }).preferences : [])];
  for (const term of preferences) {
    if (!term || typeof term !== "object") continue;
    const preference = term as Record<string, unknown>;
    if (preference.type === "PREFER_ACCOUNT") lines.push(`Prefer ${label(preference.accountReference, preference.accountId, "the selected account")} for funding if needed`);
  }
  return lines;
}

function describeGoal(value: unknown, label: (reference: unknown, id: unknown, fallback: string) => string): string {
  if (!value || typeof value !== "object") return "Review your requested action";
  const goal = value as Record<string, unknown>;
  if (goal.type === "DELIVER_MONEY") {
    const amount = goal.amount && typeof goal.amount === "object" ? goal.amount as Record<string, unknown> : {};
    const displayed = typeof amount.currency === "string" && typeof amount.minorUnits === "string" ? money(amount.currency, amount.minorUnits) : "an amount to confirm";
    return `Send ${displayed} to ${label(goal.recipientReference, goal.recipientId, "the selected recipient")}`;
  }
  if (goal.type === "ACQUIRE_ASSET") return `Buy ${String(goal.quantity ?? "a quantity to confirm")} ${label(goal.assetReference, goal.assetId, "selected asset")}`;
  return "Review your requested action";
}
