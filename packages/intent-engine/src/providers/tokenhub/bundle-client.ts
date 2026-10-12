import OpenAI from "openai";
import type { IntentBundleModelClient, IntentBundleModelInput } from "../../bundle/types.js";
import { INTENT_CANDIDATE_SCHEMA, projectTokenHubTransportCandidate, TokenHubProviderError } from "./client.js";
import type { TokenHubConfig, TokenHubThinkingMode } from "./config.js";

const strict = (required: readonly string[], properties: Record<string, unknown>) => ({
  type: "object",
  additionalProperties: false,
  required,
  properties,
});

const bundleItem = () => strict(["itemId", "goal", "constraints", "preferences"], {
  itemId: { type: "string", pattern: "^item-[1-9]\\d*$" },
  goal: INTENT_CANDIDATE_SCHEMA.properties.goal,
  constraints: INTENT_CANDIDATE_SCHEMA.properties.constraints,
  preferences: INTENT_CANDIDATE_SCHEMA.properties.preferences,
});

const dependency = () => strict(["beforeItemId", "afterItemId", "reason"], {
  beforeItemId: { type: "string", pattern: "^item-[1-9]\\d*$" },
  afterItemId: { type: "string", pattern: "^item-[1-9]\\d*$" },
  reason: { const: "USER_EXPLICIT_ORDER" },
});

/** Provider DTO uses the proven single-intent slot schemas, then projects to IntentBundleDraftV1. */
export const INTENT_BUNDLE_CANDIDATE_SCHEMA = strict(
  ["schemaVersion", "items", "globalConstraints", "explicitDependencies"],
  {
    schemaVersion: { const: "1" },
    items: { type: "array", minItems: 1, items: bundleItem() },
    globalConstraints: INTENT_CANDIDATE_SCHEMA.properties.constraints,
    explicitDependencies: { type: "array", items: dependency() },
  },
);

export type TokenHubBundleCompletionRequest = {
  model: string;
  messages: { role: "system" | "user"; content: string }[];
  temperature: 0;
  thinking?: { type: TokenHubThinkingMode };
  response_format: {
    type: "json_schema";
    json_schema: { name: string; strict: true; schema: typeof INTENT_BUNDLE_CANDIDATE_SCHEMA };
  };
};

export interface TokenHubBundleTransport {
  createCompletion(request: TokenHubBundleCompletionRequest): Promise<{ content: string | null | undefined }>;
}

class OpenAITokenHubBundleTransport implements TokenHubBundleTransport {
  private readonly client: OpenAI;
  constructor(config: TokenHubConfig) {
    this.client = new OpenAI({ baseURL: config.baseUrl, apiKey: config.apiKey, timeout: 60_000, maxRetries: 0 });
  }
  async createCompletion(request: TokenHubBundleCompletionRequest): Promise<{ content: string | null | undefined }> {
    const response = await this.client.chat.completions.create(request);
    return { content: response.choices[0]?.message.content };
  }
}

/** TokenHub adapter for bundle extraction. Output remains unknown until the bundle interpreter. */
export class TokenHubIntentBundleModelClient implements IntentBundleModelClient {
  private readonly transport: TokenHubBundleTransport;
  constructor(private readonly config: TokenHubConfig, transport?: TokenHubBundleTransport) {
    this.transport = transport ?? new OpenAITokenHubBundleTransport(config);
  }

  async generateIntentBundle(input: IntentBundleModelInput): Promise<unknown> {
    try {
      const response = await this.transport.createCompletion({
        model: this.config.model,
        messages: [{ role: "system", content: input.systemPrompt }, { role: "user", content: input.text }],
        temperature: 0,
        ...(this.config.thinking === undefined ? {} : { thinking: { type: this.config.thinking } }),
        response_format: {
          type: "json_schema",
          json_schema: { name: "intent_bundle_draft_candidate_v1", strict: true, schema: INTENT_BUNDLE_CANDIDATE_SCHEMA },
        },
      });
      if (response.content === undefined || response.content === null || response.content.trim().length === 0) {
        throw new TokenHubProviderError("TokenHub returned an empty bundle response.");
      }
      let candidate: unknown;
      try {
        candidate = JSON.parse(response.content);
      } catch {
        throw new TokenHubProviderError("TokenHub returned invalid bundle JSON.");
      }
      return projectTokenHubBundleTransportCandidate(candidate, input.text);
    } catch (error) {
      if (error instanceof TokenHubProviderError) throw error;
      throw new TokenHubProviderError("TokenHub bundle request failed.");
    }
  }
}

export function projectTokenHubBundleTransportCandidate(value: unknown, originalText: string): unknown {
  if (!isRecord(value)) return stripNullFields(value);
  const projected = stripNullFields(value) as Record<string, unknown>;
  if (Array.isArray(value.items)) {
    projected.items = value.items.map((item) => projectItem(item, originalText));
  }
  if (Object.hasOwn(value, "globalConstraints")) {
    const global = projectTokenHubTransportCandidate({
      schemaVersion: "1",
      constraints: value.globalConstraints,
      references: [],
    }, originalText);
    projected.globalConstraints = isRecord(global) ? global.constraints : value.globalConstraints;
  }
  return projected;
}

function projectItem(value: unknown, originalText: string): unknown {
  if (!isRecord(value)) return stripNullFields(value);
  const item = projectTokenHubTransportCandidate({
    schemaVersion: "1",
    goal: value.goal,
    constraints: value.constraints,
    preferences: value.preferences,
    references: [],
  }, originalText);
  if (!isRecord(item)) return stripNullFields(value);
  return {
    ...stripNullFields(value) as Record<string, unknown>,
    goal: item.goal,
    constraints: item.constraints,
    preferences: item.preferences,
  };
}

function stripNullFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNullFields);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== null)
      .map(([key, item]) => [key, stripNullFields(item)]),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
