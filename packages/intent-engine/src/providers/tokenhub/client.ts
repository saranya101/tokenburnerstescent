import OpenAI from "openai";
import type { IntentModelClient, IntentModelInput, ModelClientDiagnostic } from "../../interpreter/types.js";
import type { TokenHubConfig, TokenHubThinkingMode } from "./config.js";

const id = () => ({ type: "string", minLength: 1 });
const nullableId = (description: string) => ({ type: ["string", "null"], minLength: 1, description });
const money = (nullable = false, description?: string) => ({
  type: nullable ? ["object", "null"] : "object",
  additionalProperties: false,
  required: ["currency", "minorUnits"],
  properties: {
    currency: { type: "string", pattern: "^[A-Z]{3}$" },
    minorUnits: { type: "string", pattern: "^-?(0|[1-9]\\d*)$" },
  },
  ...(description === undefined ? {} : { description }),
});
const strict = (required: readonly string[], properties: Record<string, unknown>) => ({ type: "object", additionalProperties: false, required, properties });
const nullableStrict = (required: readonly string[], properties: Record<string, unknown>, description: string) => ({ type: ["object", "null"], additionalProperties: false, required, properties, description });
const goalSlotNames = ["deliverMoney", "acquireAsset", "payBill", "moveFunds"] as const;
const goalTypeBySlot = {
  deliverMoney: "DELIVER_MONEY",
  acquireAsset: "ACQUIRE_ASSET",
  payBill: "PAY_BILL",
  moveFunds: "MOVE_FUNDS",
} as const;
const constraintSlotNames = ["maxTotalCost", "minimumAvailableBalances", "excludedAccounts", "maxLockInDays"];
const preferenceSlotNames = ["minimizeTotalCost", "minimizeFx", "fastest", "preferredAccounts"];
const goal = () => strict(["selectedGoalType", "goalSlots"], {
  selectedGoalType: {
    type: "string",
    enum: ["DELIVER_MONEY", "ACQUIRE_ASSET", "PAY_BILL", "MOVE_FUNDS"],
    description: "Select by the requested financial action and role of the reference, not the first verb or a company-name heuristic alone. ACQUIRE_ASSET means obtaining a named asset for a budget and/or quantity. PAY_BILL means settling a bill, invoice, utility charge, merchant bill, or biller obligation, including language framed as pay <biller/company/service> <amount>; a reference identified as BILLER and being paid normally selects PAY_BILL. DELIVER_MONEY means sending money to a recipient: use it for sending or transferring money to a person, recipient, or beneficiary rather than settling a bill. MOVE_FUNDS uses amount and destinationAccountReference, with optional sourceAccountReference.",
  },
  goalSlots: strict(goalSlotNames, {
    deliverMoney: nullableStrict(["amount", "recipientReference"], {
      amount: money(false, "Money to deliver to the recipient."),
      recipientReference: { ...id(), description: "Exact human phrase identifying the recipient: the person or beneficiary receiving money. Do not use this field for a biller being paid and do not invent an ID." },
    }, "Populate only for DELIVER_MONEY when sending or transferring money to a person, recipient, or beneficiary rather than settling a bill; otherwise null."),
    acquireAsset: nullableStrict(["assetReference", "budget", "quantity"], {
      assetReference: { ...id(), description: "Exact human phrase naming the asset being acquired. Do not replace it with money or an ID." },
      budget: money(true, "Money available to acquire the asset; null when the user specifies quantity only."),
      quantity: { type: ["string", "null"], pattern: "^(0|[1-9]\\d*)(\\.\\d+)?$", description: "Non-negative asset quantity; null when the user specifies budget only." },
    }, "Populate only for ACQUIRE_ASSET; otherwise null. This slot never contains amount."),
    payBill: nullableStrict(["billerReference", "amount"], {
      billerReference: { ...id(), description: "Exact human phrase identifying the biller, company, merchant, or service whose bill, invoice, charge, or obligation is being paid. A BILLER reference being paid normally belongs here. Do not invent an ID." },
      amount: money(true, "Money to pay when explicitly stated; otherwise null."),
    }, "Populate only for PAY_BILL when settling a bill, invoice, utility charge, merchant bill, or biller obligation, including pay <biller/company/service> <amount>; otherwise null. Classify from the role and requested financial action, not a company name alone."),
    moveFunds: nullableStrict(["amount", "destinationAccountReference", "sourceAccountReference"], {
      amount: money(false, "Money to move between accounts."),
      destinationAccountReference: { ...id(), description: "Exact human phrase identifying the destination account. Do not invent an ID." },
      sourceAccountReference: nullableId("Exact human phrase identifying the source account when stated; otherwise null. Do not invent an ID."),
    }, "Populate only for MOVE_FUNDS; otherwise null."),
  }),
});

const constraintSlots = () => strict(constraintSlotNames, {
  maxTotalCost: money(true, "Non-null means the user explicitly stated an overall spending or cost ceiling, such as spend no more than a stated amount. Use null when no such ceiling was explicitly stated. Never invent a value or use zero, false, an empty string, or another sentinel for absence."),
  minimumAvailableBalances: {
    type: "array",
    description: "Every item must come from an explicitly stated minimum available-balance requirement. Use an empty array when none was explicitly stated. Never invent an item or use a sentinel item for absence.",
    items: strict(["money", "accountReference"], {
      money: money(false),
      accountReference: nullableId("Exact human account phrase when the minimum applies to a named account; otherwise null."),
    }),
  },
  excludedAccounts: {
    type: "array",
    description: "Every item must be an explicitly prohibited account, such as an account the user said not to use or touch. Use an empty array when none was explicitly prohibited. Never invent an account or use an empty string or another sentinel for absence.",
    items: id(),
  },
  maxLockInDays: nullableStrict(["days", "evidence"], {
    days: { type: "integer", minimum: 0, description: "Maximum lock-in days explicitly stated by the user. Zero is a real zero-lock-in constraint, never an absence sentinel." },
    evidence: { type: "string", minLength: 1, description: "Non-empty exact phrase copied verbatim from the user's input that explicitly states lock-in or locked-duration semantics." },
  }, "Non-null only when the user explicitly states a lock-in restriction. Null means no lock-in restriction was stated. Zero days is valid only with verbatim evidence explicitly requiring zero lock-in or no lock-in; never use zero as a default or substitute for absence."),
});

const preferenceSlots = () => strict(preferenceSlotNames, {
  minimizeTotalCost: { type: "boolean", description: "True only when the user explicitly prefers minimizing total cost; otherwise false. Never invent this preference merely to fill the slot." },
  minimizeFx: { type: "boolean", description: "True only when the user explicitly prefers minimizing foreign exchange; otherwise false. Never invent this preference merely to fill the slot." },
  fastest: { type: "boolean", description: "True only when the user explicitly prefers the fastest outcome; otherwise false. Never invent this preference merely to fill the slot." },
  preferredAccounts: { type: "array", description: "Every item must be an exact human account phrase explicitly preferred by the user. Use an empty array when none was stated; never invent an account or sentinel item.", items: id() },
});

const reference = () => strict(["reference", "expectedEntityType"], {
  reference: id(),
  expectedEntityType: { type: ["string", "null"], enum: ["ACCOUNT", "BENEFICIARY", "ASSET", "BILLER", "OBLIGATION", null] },
});

/** The generation constraint covers only model-owned fields; originalText is application-owned. */
export const INTENT_CANDIDATE_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["schemaVersion", "goal", "constraints", "preferences", "references"],
  properties: {
    schemaVersion: { const: "1" },
    // Keep this provider boundary simple: type-specific semantics remain IntentDraftV1's responsibility.
    goal: goal(),
    constraints: constraintSlots(),
    preferences: preferenceSlots(),
    references: { type: "array", items: reference() },
  },
};

export type TokenHubCompletionRequest = {
  model: string;
  messages: { role: "system" | "user"; content: string }[];
  temperature: 0;
  thinking?: { type: TokenHubThinkingMode };
  response_format: { type: "json_schema"; json_schema: { name: string; strict: true; schema: typeof INTENT_CANDIDATE_SCHEMA } };
};

export interface TokenHubTransport {
  createCompletion(request: TokenHubCompletionRequest): Promise<{ content: string | null | undefined }>;
}

export interface TokenHubConstraintProjectionDiagnostic {
  readonly rawMaxLockInDays: unknown;
  readonly projectedConstraints: unknown;
}

/** Opt-in development diagnostics. Never receives headers, credentials, user text, or the full candidate. */
export interface TokenHubDevelopmentDiagnostics {
  readonly onConstraintProjection?: (diagnostic: TokenHubConstraintProjectionDiagnostic) => void;
}

class OpenAITokenHubTransport implements TokenHubTransport {
  private readonly client: OpenAI;
  constructor(config: TokenHubConfig) {
    // Keep 60s until production latency data is available; the successful disabled-thinking run was not timed reliably.
    this.client = new OpenAI({ baseURL: config.baseUrl, apiKey: config.apiKey, timeout: 60_000, maxRetries: 0 });
  }
  async createCompletion(request: TokenHubCompletionRequest): Promise<{ content: string | null | undefined }> {
    const response = await this.client.chat.completions.create(request);
    return { content: response.choices[0]?.message.content };
  }
}

export class TokenHubProviderError extends Error {
  readonly name = "TokenHubProviderError";
  constructor(message: string, readonly diagnostic?: ModelClientDiagnostic) { super(message); }
}

/** OpenAI-compatible TokenHub adapter. Its parsed output remains untrusted. */
export class TokenHubIntentModelClient implements IntentModelClient {
  private readonly transport: TokenHubTransport;
  constructor(
    private readonly config: TokenHubConfig,
    transport?: TokenHubTransport,
    private readonly developmentDiagnostics?: TokenHubDevelopmentDiagnostics,
  ) {
    this.transport = transport ?? new OpenAITokenHubTransport(config);
  }
  async generateIntent(input: IntentModelInput): Promise<unknown> {
    try {
      const response = await this.transport.createCompletion({
        model: this.config.model,
        messages: [{ role: "system", content: input.systemPrompt }, { role: "user", content: input.text }],
        temperature: 0,
        ...(this.config.thinking === undefined ? {} : { thinking: { type: this.config.thinking } }),
        response_format: { type: "json_schema", json_schema: { name: "intent_draft_candidate_v1", strict: true, schema: INTENT_CANDIDATE_SCHEMA } },
      });
      if (response.content === undefined || response.content === null || response.content.trim().length === 0) {
        throw new TokenHubProviderError("TokenHub returned an empty response.");
      }
      try {
        const transportCandidate: unknown = JSON.parse(response.content);
        const projected = projectTokenHubTransportCandidate(transportCandidate, input.text);
        this.developmentDiagnostics?.onConstraintProjection?.({
          rawMaxLockInDays: isRecord(transportCandidate) && isRecord(transportCandidate.constraints)
            ? transportCandidate.constraints.maxLockInDays
            : undefined,
          projectedConstraints: isRecord(projected) ? projected.constraints : undefined,
        });
        return projected;
      } catch {
        throw new TokenHubProviderError("TokenHub returned invalid JSON.");
      }
    } catch (error) {
      if (error instanceof TokenHubProviderError) throw error;
      // Never include SDK/network internals, headers, or credentials in normal errors.
      throw new TokenHubProviderError("TokenHub request failed.", providerDiagnostic(error, this.config.apiKey));
    }
  }
}

/** Projects explicit provider slots and otherwise removes only null-valued object fields. */
export function projectTokenHubTransportCandidate(value: unknown, originalText?: string): unknown {
  if (!isRecord(value)) return stripNullFields(value);
  const projected = stripNullFields(value) as Record<string, unknown>;
  if (Object.hasOwn(value, "goal")) projected.goal = projectGoalSlots(value.goal);
  if (Object.hasOwn(value, "constraints")) projected.constraints = projectConstraintSlots(value.constraints, originalText);
  if (Object.hasOwn(value, "preferences")) projected.preferences = projectPreferenceSlots(value.preferences);
  return projected;
}

function projectGoalSlots(value: unknown): unknown {
  if (!isCompleteSlotObject(value, ["selectedGoalType", "goalSlots"])) return stripNullFields(value);
  const slots = value.goalSlots;
  if (!isCompleteSlotObject(slots, goalSlotNames)) return stripNullFields(value);
  const activeSlots = goalSlotNames.filter((slot) => slots[slot] !== null);
  const activeSlot = activeSlots[0];
  if (activeSlots.length !== 1 || activeSlot === undefined || goalTypeBySlot[activeSlot] !== value.selectedGoalType) {
    return stripNullFields(value);
  }
  const selected = slots[activeSlot];
  if (!isRecord(selected) || Object.hasOwn(selected, "type")) return stripNullFields(value);
  return { type: value.selectedGoalType, ...(stripNullFields(selected) as Record<string, unknown>) };
}

function projectConstraintSlots(value: unknown, originalText: string | undefined): unknown {
  if (!isCompleteSlotObject(value, constraintSlotNames)) return stripNullFields(value);
  if (!Array.isArray(value.minimumAvailableBalances) || !Array.isArray(value.excludedAccounts)) return stripNullFields(value);
  if (!value.minimumAvailableBalances.every((entry) => isCompleteSlotObject(entry, ["money", "accountReference"]))) return stripNullFields(value);

  const constraints: unknown[] = [];
  if (value.maxTotalCost !== null) constraints.push({ type: "MAX_TOTAL_COST", money: stripNullFields(value.maxTotalCost) });
  for (const entry of value.minimumAvailableBalances) {
    const balance = entry as Record<string, unknown>;
    constraints.push({
      type: "MIN_AVAILABLE_BALANCE",
      money: stripNullFields(balance.money),
      ...(balance.accountReference === null ? {} : { accountReference: stripNullFields(balance.accountReference) }),
    });
  }
  for (const accountReference of value.excludedAccounts) {
    constraints.push({ type: "EXCLUDED_ACCOUNT", accountReference: stripNullFields(accountReference) });
  }
  if (value.maxLockInDays !== null) {
    if (!isCompleteSlotObject(value.maxLockInDays, ["days", "evidence"])) return stripNullFields(value);
    const evidence = value.maxLockInDays.evidence;
    if (
      typeof evidence !== "string"
      || evidence.trim().length === 0
      || originalText === undefined
      || !originalText.includes(evidence)
      || !explicitlyConcernsLockIn(evidence)
    ) return stripNullFields(value);
    constraints.push({ type: "MAX_LOCK_IN_DAYS", days: stripNullFields(value.maxLockInDays.days) });
  }
  return constraints;
}

function explicitlyConcernsLockIn(evidence: string): boolean {
  return /\b(?:lock[ -]?in|locked)\b/i.test(evidence);
}

function projectPreferenceSlots(value: unknown): unknown {
  if (!isCompleteSlotObject(value, preferenceSlotNames) || !Array.isArray(value.preferredAccounts)) return stripNullFields(value);
  if (typeof value.minimizeTotalCost !== "boolean" || typeof value.minimizeFx !== "boolean" || typeof value.fastest !== "boolean") return stripNullFields(value);

  const preferences: unknown[] = [];
  if (value.minimizeTotalCost) preferences.push({ type: "MINIMIZE_TOTAL_COST" });
  if (value.minimizeFx) preferences.push({ type: "MINIMIZE_FX" });
  if (value.fastest) preferences.push({ type: "FASTEST" });
  for (const accountReference of value.preferredAccounts) {
    preferences.push({ type: "PREFER_ACCOUNT", accountReference: stripNullFields(accountReference) });
  }
  return preferences;
}

function stripNullFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNullFields);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, fieldValue]) => fieldValue !== null)
      .map(([key, fieldValue]) => [key, stripNullFields(fieldValue)]),
  );
}

function isCompleteSlotObject<const T extends readonly string[]>(value: unknown, slots: T): value is Record<T[number], unknown> {
  return isRecord(value) && slots.every((slot) => Object.hasOwn(value, slot));
}

function providerDiagnostic(error: unknown, apiKey: string): ModelClientDiagnostic | undefined {
  if (!isRecord(error)) return undefined;
  const diagnostic: ModelClientDiagnostic = {
    ...(typeof error.status === "number" ? { status: error.status } : {}),
    ...(typeof error.code === "string" ? { code: safeText(error.code, apiKey) } : {}),
    ...(typeof error.type === "string" ? { type: safeText(error.type, apiKey) } : {}),
    ...(typeof error.message === "string" ? { message: safeText(error.message, apiKey) } : {}),
    ...(typeof error.request_id === "string" ? { requestId: safeText(error.request_id, apiKey) } : typeof error.requestId === "string" ? { requestId: safeText(error.requestId, apiKey) } : {}),
  };
  return Object.keys(diagnostic).length === 0 ? undefined : diagnostic;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function safeText(value: string, apiKey: string): string {
  const withoutConfiguredKey = apiKey.length === 0 ? value : value.split(apiKey).join("[REDACTED]");
  return withoutConfiguredKey.slice(0, 1_000)
    .replace(/authorization\s*[:=][^,;\n]*/gi, "Authorization: [REDACTED]")
    .replace(/(bearer\s+)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/(api[_ -]?key\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]");
}
