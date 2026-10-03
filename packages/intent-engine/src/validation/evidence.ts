import type { MoneyV1 } from "@parlance/contracts";

interface MoneyEvidence {
  readonly currency?: string;
  readonly minorUnits: string;
  readonly start: number;
  readonly end: number;
}

const PREFIX_MONEY = /(?:\b(USD|SGD)\b\s*|\b(US\$|S\$)\s*|(\$)\s*)([0-9][0-9,]*(?:\.[0-9]{1,2})?)/giu;
const SUFFIX_MONEY = /\b([0-9][0-9,]*(?:\.[0-9]{1,2})?)\s*(USD|SGD)\b/giu;

export function sourceSupportsMoney(sourceText: string, money: MoneyV1): boolean {
  return matchingMoneyEvidence(sourceText, money).length > 0;
}

export function sourceSupportsGoalType(sourceText: string, goalType: string): boolean {
  switch (goalType) {
    case "DELIVER_MONEY": return /\b(?:send|deliver|remit|wire|transfer)\b/iu.test(sourceText);
    case "ACQUIRE_ASSET": return /\b(?:acquire|buy|purchase|get|invest\s+in)\b/iu.test(sourceText);
    case "PAY_BILL": return /\b(?:pay|settle)\b/iu.test(sourceText);
    case "MOVE_FUNDS": return /\b(?:move|transfer)\b/iu.test(sourceText);
    default: return false;
  }
}

export function sourceSupportsMaxTotalCost(sourceText: string, money: MoneyV1): boolean {
  return matchingMoneyEvidence(sourceText, money).some((evidence) => moneyHasMaxCostContext(sourceText, evidence));
}

export function sourceSignalsMaxTotalCost(sourceText: string): boolean {
  return moneyEvidence(sourceText).some((evidence) => moneyHasMaxCostContext(sourceText, evidence));
}

export function sourceSupportsMinimumBalance(sourceText: string, money: MoneyV1): boolean {
  return matchingMoneyEvidence(sourceText, money).some((evidence) => moneyHasMinimumBalanceContext(sourceText, evidence));
}

export function sourceSignalsMinimumBalance(sourceText: string): boolean {
  return moneyEvidence(sourceText).some((evidence) => moneyHasMinimumBalanceContext(sourceText, evidence));
}

export function sourceSupportsExcludedReference(sourceText: string, reference: string): boolean {
  const source = normalizeForEvidence(sourceText);
  const target = normalizeForEvidence(reference);
  const index = source.indexOf(target);
  if (index < 0) return false;
  const before = source.slice(Math.max(0, index - 80), index);
  return /(?:don['’]?t|do\s+not|never)\s+(?:use|touch)(?:\s+the)?\s*$|(?:avoid|exclude)(?:\s+using)?(?:\s+the)?\s*$|without\s+using(?:\s+the)?\s*$/iu.test(before);
}

export function sourceSignalsExcludedAccount(sourceText: string): boolean {
  return /\b(?:(?:don['’]?t|do\s+not|never)\s+(?:use|touch)|avoid\s+using|exclude|without\s+using)\b/iu.test(sourceText);
}

export function sourceLockInDays(sourceText: string): readonly number[] {
  const days = new Set<number>();
  if (/\b(?:no|zero)[ -]?lock[ -]?in\b|\b0\s*(?:day\s+)?lock[ -]?in\b/iu.test(sourceText)) days.add(0);
  const patterns = [
    /\b(?:no\s+more\s+than|at\s+most|up\s+to|maximum(?:\s+of)?)\s+(\d+)\s+(?:calendar\s+)?days?\s+(?:of\s+)?lock[ -]?in\b/giu,
    /\block[ -]?in(?:\s+period)?(?:\s+of)?\s*(?:no\s+more\s+than|at\s+most|up\s+to|maximum(?:\s+of)?)?\s*(\d+)\s+days?\b/giu,
    /\b(\d+)\s+lock[ -]?in\s+days?\b/giu,
  ];
  for (const pattern of patterns) {
    for (const match of sourceText.matchAll(pattern)) {
      const value = Number(match[1]);
      if (Number.isSafeInteger(value) && value >= 0) days.add(value);
    }
  }
  return [...days].sort((left, right) => left - right);
}

export function sourceSignalsLockIn(sourceText: string): boolean {
  return /\b(?:lock[ -]?in|locked)\b/iu.test(sourceText);
}

export function sourceSupportsPreference(sourceText: string, type: string, reference?: string): boolean {
  switch (type) {
    case "FASTEST": return /\b(?:as\s+fast\s+as\s+possible|fastest|as\s+quickly\s+as\s+possible)\b/iu.test(sourceText);
    case "MINIMIZE_TOTAL_COST": return /\b(?:minimi[sz]e\s+(?:the\s+)?total\s+cost|lowest\s+total\s+cost|cheapest|keep\s+(?:the\s+)?costs?\s+as\s+low\s+as\s+possible)\b/iu.test(sourceText);
    case "MINIMIZE_FX": return /\b(?:minimi[sz]e\s+(?:fx|foreign\s+exchange|currency\s+conversion)|avoid\s+(?:fx|foreign\s+exchange|currency\s+conversion)|fewest\s+currency\s+conversions?)\b/iu.test(sourceText);
    case "PREFER_ACCOUNT": return reference !== undefined && sourceSupportsPreferredReference(sourceText, reference);
    default: return false;
  }
}

export function sourceSignalsPreference(sourceText: string, type: "FASTEST" | "MINIMIZE_TOTAL_COST" | "MINIMIZE_FX"): boolean {
  return sourceSupportsPreference(sourceText, type);
}

export function sourceSignalsPreferredAccount(sourceText: string): boolean {
  return /\bprefer(?:ably)?\s+(?:using\s+|use\s+)?\S|\buse\b[\s\S]{1,60}\bif\s+possible\b/iu.test(sourceText);
}

export function sourceContainsReference(sourceText: string, reference: string): boolean {
  return sourceText.includes(reference);
}

export function looksLikeCanonicalIdentifier(value: string): boolean {
  return /^(?:acc(?:ount)?|asset|ben(?:eficiary)?|biller|entity|obligation|recipient)[_-][a-z0-9][a-z0-9_-]*$/iu.test(value);
}

function sourceSupportsPreferredReference(sourceText: string, reference: string): boolean {
  const source = normalizeForEvidence(sourceText);
  const target = normalizeForEvidence(reference);
  let index = source.indexOf(target);
  while (index >= 0) {
    const before = source.slice(Math.max(0, index - 60), index);
    const after = source.slice(index + target.length, index + target.length + 40);
    const explicitlyUsesReference = /\b(?:use|using)\s+(?:the\s+)?$/iu.test(before)
      && !/(?:don['’]?t|do\s+not|never)\s+use\s+(?:the\s+)?$/iu.test(before);
    if (
      /\bprefer(?:ably)?\s+(?:using\s+|use\s+)?(?:the\s+)?$/iu.test(before)
      || explicitlyUsesReference
      || /\buse\s+(?:the\s+)?$/iu.test(before) && /^.{0,20}\bif\s+possible\b/iu.test(after)
    ) return true;
    index = source.indexOf(target, index + target.length);
  }
  return false;
}

function moneyEvidence(sourceText: string): readonly MoneyEvidence[] {
  const evidence: MoneyEvidence[] = [];
  for (const match of sourceText.matchAll(PREFIX_MONEY)) {
    const amount = match[4];
    if (amount === undefined) continue;
    const minorUnits = toMinorUnits(amount);
    if (minorUnits === undefined) continue;
    const currency = match[1]?.toUpperCase() ?? symbolCurrency(match[2]);
    const start = match.index;
    const end = start + match[0].length;
    evidence.push(currency === undefined ? { minorUnits, start, end } : { currency, minorUnits, start, end });
  }
  for (const match of sourceText.matchAll(SUFFIX_MONEY)) {
    const amount = match[1];
    const currency = match[2]?.toUpperCase();
    if (amount === undefined || currency === undefined) continue;
    const minorUnits = toMinorUnits(amount);
    if (minorUnits !== undefined) {
      const start = match.index;
      evidence.push({ currency, minorUnits, start, end: start + match[0].length });
    }
  }
  return evidence;
}

function symbolCurrency(symbol: string | undefined): string | undefined {
  if (symbol?.toUpperCase() === "US$") return "USD";
  if (symbol?.toUpperCase() === "S$") return "SGD";
  return undefined;
}

function toMinorUnits(amount: string): string | undefined {
  const normalized = amount.replaceAll(",", "");
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/u.test(normalized)) return undefined;
  const [major, fraction = ""] = normalized.split(".");
  if (major === undefined) return undefined;
  return (BigInt(major) * 100n + BigInt(fraction.padEnd(2, "0"))).toString();
}

function normalizeForEvidence(value: string): string {
  return value.trim().replace(/\s+/gu, " ").toLocaleLowerCase();
}

function matchingMoneyEvidence(sourceText: string, money: MoneyV1): readonly MoneyEvidence[] {
  return moneyEvidence(sourceText).filter((evidence) =>
    evidence.minorUnits === money.minorUnits
    && (evidence.currency === undefined || evidence.currency === money.currency)
  );
}

function moneyHasMaxCostContext(sourceText: string, evidence: MoneyEvidence): boolean {
  const before = sourceText.slice(Math.max(0, evidence.start - 90), evidence.start);
  const after = sourceText.slice(evidence.end, evidence.end + 70);
  return /\b(?:without\s+spending\s+more\s+than|spend(?:ing)?\s+no\s+more\s+than|no\s+more\s+than|at\s+most|(?:cost|budget)\s+cap(?:\s+of)?|maximum\s+(?:total\s+)?(?:cost|spend)(?:\s+of)?)\s*$/iu.test(before)
    || /^\s*(?:total\s+)?(?:maximum\s+(?:total\s+)?(?:cost|spend)|(?:cost|budget)\s+cap)\b/iu.test(after);
}

function moneyHasMinimumBalanceContext(sourceText: string, evidence: MoneyEvidence): boolean {
  const before = sourceText.slice(Math.max(0, evidence.start - 90), evidence.start);
  const after = sourceText.slice(evidence.end, evidence.end + 90);
  return /\b(?:keep|maintain|leave)\b[\s\S]{0,70}\b(?:at\s+least|minimum)\s*$/iu.test(before)
    || /\bminimum(?:\s+available)?(?:\s+balance)?(?:\s+of)?\s*$/iu.test(before)
    || /^\s*(?:or\s+more\s+)?(?:available|remaining|minimum\s+(?:available\s+)?balance)\b/iu.test(after);
}
