import type { MoneyV1 } from "@parlance/contracts";

interface MoneyEvidence {
  readonly currency?: string;
  readonly minorUnits: string;
  readonly start: number;
  readonly end: number;
}

export type SourceActionGoalType = "DELIVER_MONEY" | "ACQUIRE_ASSET" | "PAY_BILL" | "MOVE_FUNDS";

export interface SourceActionSignal {
  readonly type: SourceActionGoalType;
  readonly start: number;
  readonly end: number;
}

const PREFIX_MONEY = /(?:\b(USD|SGD)\b\s*|\b(US\$|S\$)\s*|(\$)\s*)([0-9][0-9,]*(?:\.[0-9]{1,2})?)/giu;
const SUFFIX_MONEY = /\b([0-9][0-9,]*(?:\.[0-9]{1,2})?)\s*(USD|SGD)\b/giu;

export function sourceSupportsMoney(sourceText: string, money: MoneyV1): boolean {
  return matchingMoneyEvidence(sourceText, money).length > 0;
}

export function sourceSupportsGoalType(sourceText: string, goalType: string): boolean {
  return sourceActionSignals(sourceText).some(({ type }) => type === goalType);
}

/** Requires an explicit quantity next to an asset unit within a positive acquisition clause. */
export function sourceSupportsQuantity(sourceText: string, quantity: string): boolean {
  const expected = canonicalQuantity(quantity);
  if (expected === undefined) return false;
  const signals = sourceActionSignals(sourceText);
  return signals.some((signal, index) => {
    if (signal.type !== "ACQUIRE_ASSET") return false;
    const clause = sourceActionClause(sourceText, signals, index);
    return clause !== undefined && quantityEvidence(acquisitionInstructionSpan(clause)).some((observed) => observed === expected);
  });
}

/** Positive financial action signals shared by routing and independent semantic validation. */
export function sourceActionSignals(sourceText: string): readonly SourceActionSignal[] {
  if (hasUnsafeInstructionFraming(sourceText)) return [];
  const pattern = /\b(send(?:ing)?|deliver(?:ing)?|remit(?:ting)?|wire|transfer(?:ring)?|buy(?:ing)?|acquir(?:e|ing)|purchas(?:e|ing)|get(?:ting)?|invest(?:ing)?\s+in|pay(?:ing)?|settl(?:e|ing)|mov(?:e|ing))\b/giu;
  const quoted = quotedRanges(sourceText);
  const signals: SourceActionSignal[] = [];
  for (const match of sourceText.matchAll(pattern)) {
    const verb = match[1]?.toLocaleLowerCase();
    if (verb === undefined || match.index === undefined || insideRange(match.index, quoted)) continue;
    if (isLocallyNegated(sourceText, match.index) || isExplicitlyNonInstructionAction(sourceText, match.index) || isNominalAction(sourceText, match.index, verb)) continue;
    const followingText = sourceText.slice(match.index, match.index + 140);
    if (/^get/u.test(verb) && !financialGetContext(followingText)) continue;
    signals.push({ type: goalTypeForVerb(verb, followingText), start: match.index, end: match.index + match[0].length });
  }
  return signals;
}

export function sourceActionClause(sourceText: string, signals: readonly SourceActionSignal[], index: number): string | undefined {
  const signal = signals[index];
  if (signal === undefined) return undefined;
  const nextActionStart = signals[index + 1]?.start ?? sourceText.length;
  const remainder = sourceText.slice(signal.end, nextActionStart);
  const sentenceBoundary = remainder.search(/[;!?\n]|\.(?=\s|$)/u);
  const clauseEnd = sentenceBoundary < 0 ? nextActionStart : signal.end + sentenceBoundary;
  return sourceText.slice(signal.start, clauseEnd);
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
    && evidence.currency === money.currency
  );
}

function goalTypeForVerb(verb: string, followingText: string): SourceActionGoalType {
  if (/^(?:buy|buying|acquir|purchas|get|getting|invest)/u.test(verb)) return "ACQUIRE_ASSET";
  if (/^(?:pay|sett)/u.test(verb)) return "PAY_BILL";
  if (/^mov/u.test(verb)) return "MOVE_FUNDS";
  if (/^transfer/u.test(verb) && /\bfrom\b[\s\S]{0,80}\bto\b/iu.test(followingText)) return "MOVE_FUNDS";
  return "DELIVER_MONEY";
}

function isLocallyNegated(sourceText: string, actionStart: number): boolean {
  const before = sourceText.slice(Math.max(0, actionStart - 100), actionStart);
  return /(?:\bdon['’]?t|\bdo\s+not|\bnever|\bmust\s+not|\bshould\s+not|\bnot)(?:\s+(?:want|try|attempt)\s+to|\s+to)?\s+(?:(?:ever|actually|really)\s+)?$/iu.test(before);
}

function isExplicitlyNonInstructionAction(sourceText: string, actionStart: number): boolean {
  const before = sourceText.slice(Math.max(0, actionStart - 50), actionStart);
  const sentenceEnd = sourceText.slice(actionStart).search(/[.;!?\n]/u);
  const sentence = sourceText.slice(actionStart, sentenceEnd < 0 ? sourceText.length : actionStart + sentenceEnd);
  return /\bignore\s+(?:the\s+)?(?:phrase|words?)\s*$/iu.test(before)
    || /\b(?:as\s+an?\s+example|not\s+an?\s+instruction)\b/iu.test(sentence);
}

function isNominalAction(sourceText: string, actionStart: number, verb: string): boolean {
  if (!/^(?:purchase|transfer|payment)/u.test(verb)) return false;
  return /\b(?:the|this|that|a)\s+$/iu.test(sourceText.slice(Math.max(0, actionStart - 20), actionStart));
}

function financialGetContext(followingText: string): boolean {
  return /^get(?:ting)?\s+(?:a|an|one|two|three|four|five|six|seven|eight|nine|ten|[0-9]+(?:\.[0-9]+)?)\s+(?:[\p{L}\p{N}.&'’_-]+\s+){0,4}(?:shares?|stocks?|funds?|bonds?|assets?|units?|etfs?)\b/iu.test(followingText);
}

function quotedRanges(sourceText: string): readonly { start: number; end: number }[] {
  const ranges: Array<{ start: number; end: number }> = [];
  for (const match of sourceText.matchAll(/(["“])[\s\S]*?(?:["”])/gu)) {
    if (match.index !== undefined) ranges.push({ start: match.index, end: match.index + match[0].length });
  }
  return ranges;
}

function insideRange(index: number, ranges: readonly { start: number; end: number }[]): boolean {
  return ranges.some(({ start, end }) => index > start && index < end);
}

function hasUnsafeInstructionFraming(sourceText: string): boolean {
  return /(?:^|\n)\s*(?:SYSTEM|ASSISTANT|DEVELOPER)\s*:/iu.test(sourceText)
    || /\{\s*["']items["']\s*:/iu.test(sourceText)
    || /\bignore\s+(?:the\s+)?(?:first|second|previous|prior|above|last)\s+action\b/iu.test(sourceText)
    || /\beven\s+though\s+i\s+said\b/iu.test(sourceText);
}

function quantityEvidence(sourceText: string): readonly string[] {
  const quantities: string[] = [];
  const pattern = /\b(a|an|one|two|three|four|five|six|seven|eight|nine|ten|[0-9]+(?:\.[0-9]+)?)\s+(?:[\p{L}\p{N}.&'’_-]+\s+){0,4}(?:shares?|units?|stocks?|assets?)\b/giu;
  for (const match of sourceText.matchAll(pattern)) {
    const token = match[1];
    if (token === undefined) continue;
    const numeric = quantityWord(token) ?? canonicalQuantity(token);
    if (numeric !== undefined) quantities.push(numeric);
  }
  return quantities;
}

/**
 * Quantity evidence must occur in the acquisition instruction itself, before a new sentence or
 * an explicit background/reason clause. This deliberately rejects uncommon ambiguous wording.
 */
function acquisitionInstructionSpan(clause: string): string {
  const boundaries = [
    /[;!?\n]/u,
    /\.(?=\s|$)/u,
    /\b(?:because|since|given\s+that)\b/iu,
    /\b(?:and\s+)?i\s+(?:already|currently)\s+(?:own|hold|have)\b/iu,
    /\b(?:and\s+)?my\s+current\s+(?:holding|position|portfolio)\b/iu,
    /\b(?:and\s+)?the\s+portfolio\s+(?:shows?|contains?|has)\b/iu,
  ];
  const boundary = boundaries
    .map((pattern) => clause.search(pattern))
    .filter((index) => index >= 0)
    .reduce((earliest, index) => Math.min(earliest, index), clause.length);
  return clause.slice(0, boundary);
}

function quantityWord(value: string): string | undefined {
  return ({ a: "1", an: "1", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10" } as Record<string, string>)[value.toLocaleLowerCase()];
}

function canonicalQuantity(value: string): string | undefined {
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u.test(value)) return undefined;
  const [integer, fraction] = value.split(".");
  if (integer === undefined) return undefined;
  const trimmedFraction = fraction?.replace(/0+$/u, "") ?? "";
  return trimmedFraction.length === 0 ? integer : `${integer}.${trimmedFraction}`;
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
