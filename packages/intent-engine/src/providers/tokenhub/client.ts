import OpenAI from "openai";
import type { IntentModelClient, IntentModelInput } from "../../interpreter/types.js";
import type { TokenHubConfig } from "./config.js";

const id = () => ({ type: "string", minLength: 1 });
const money = () => ({ type: "object", additionalProperties: false, required: ["currency", "minorUnits"], properties: { currency: { type: "string", pattern: "^[A-Z]{3}$" }, minorUnits: { type: "string", pattern: "^-?(0|[1-9]\\d*)$" } } });
const strict = (required: string[], properties: Record<string, unknown>) => ({ type: "object", additionalProperties: false, required, properties });
const acquireAsset = () => ({
  type: "object", additionalProperties: false, required: ["type", "assetReference"],
  anyOf: [{ required: ["quantity"] }, { required: ["budget"] }],
  properties: { type: { const: "ACQUIRE_ASSET" }, assetReference: id(), budget: money(), quantity: { type: "string", pattern: "^(0|[1-9]\\d*)(\\.\\d+)?$" } },
});

/** The generation constraint covers only model-owned fields; originalText is application-owned. */
export const INTENT_CANDIDATE_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["schemaVersion", "goal", "constraints", "preferences", "references"],
  properties: {
    schemaVersion: { const: "1" },
    goal: { oneOf: [
      strict(["type", "amount", "recipientReference"], { type: { const: "DELIVER_MONEY" }, amount: money(), recipientReference: id() }),
      acquireAsset(),
      strict(["type", "billerReference"], { type: { const: "PAY_BILL" }, billerReference: id(), amount: money() }),
      strict(["type", "amount", "destinationAccountReference"], { type: { const: "MOVE_FUNDS" }, amount: money(), sourceAccountReference: id(), destinationAccountReference: id() }),
    ] },
    constraints: { type: "array", items: { oneOf: [
      strict(["type", "money"], { type: { const: "MAX_TOTAL_COST" }, money: money() }),
      strict(["type", "money"], { type: { const: "MIN_AVAILABLE_BALANCE" }, money: money(), accountReference: id() }),
      strict(["type", "accountReference"], { type: { const: "EXCLUDED_ACCOUNT" }, accountReference: id() }),
      strict(["type", "days"], { type: { const: "MAX_LOCK_IN_DAYS" }, days: { type: "integer", minimum: 0 } }),
    ] } },
    preferences: { type: "array", items: { oneOf: [
      strict(["type"], { type: { const: "MINIMIZE_TOTAL_COST" } }), strict(["type"], { type: { const: "MINIMIZE_FX" } }), strict(["type"], { type: { const: "FASTEST" } }),
      strict(["type", "accountReference"], { type: { const: "PREFER_ACCOUNT" }, accountReference: id() }),
    ] } },
    references: { type: "array", items: strict(["reference"], { reference: id(), expectedEntityType: { enum: ["ACCOUNT", "BENEFICIARY", "ASSET", "BILLER", "OBLIGATION"] } }) },
  },
};

export type TokenHubCompletionRequest = {
  model: string;
  messages: { role: "system" | "user"; content: string }[];
  temperature: 0;
  response_format: { type: "json_schema"; json_schema: { name: string; strict: true; schema: typeof INTENT_CANDIDATE_SCHEMA } };
};

export interface TokenHubTransport {
  createCompletion(request: TokenHubCompletionRequest): Promise<{ content: string | null | undefined }>;
}

class OpenAITokenHubTransport implements TokenHubTransport {
  private readonly client: OpenAI;
  constructor(config: TokenHubConfig) {
    this.client = new OpenAI({ baseURL: config.baseUrl, apiKey: config.apiKey, timeout: 15_000, maxRetries: 0 });
  }
  async createCompletion(request: TokenHubCompletionRequest): Promise<{ content: string | null | undefined }> {
    const response = await this.client.chat.completions.create(request);
    return { content: response.choices[0]?.message.content };
  }
}

export class TokenHubProviderError extends Error {
  readonly name = "TokenHubProviderError";
}

/** OpenAI-compatible TokenHub adapter. Its parsed output remains untrusted. */
export class TokenHubIntentModelClient implements IntentModelClient {
  private readonly transport: TokenHubTransport;
  constructor(private readonly config: TokenHubConfig, transport?: TokenHubTransport) {
    this.transport = transport ?? new OpenAITokenHubTransport(config);
  }
  async generateIntent(input: IntentModelInput): Promise<unknown> {
    try {
      const response = await this.transport.createCompletion({
        model: this.config.model,
        messages: [{ role: "system", content: input.systemPrompt }, { role: "user", content: input.text }],
        temperature: 0,
        response_format: { type: "json_schema", json_schema: { name: "intent_draft_candidate_v1", strict: true, schema: INTENT_CANDIDATE_SCHEMA } },
      });
      if (response.content === undefined || response.content === null || response.content.trim().length === 0) {
        throw new TokenHubProviderError("TokenHub returned an empty response.");
      }
      return JSON.parse(response.content) as unknown;
    } catch (error) {
      if (error instanceof TokenHubProviderError) throw error;
      // Never include SDK/network internals, headers, or credentials in normal errors.
      throw new TokenHubProviderError("TokenHub request failed.");
    }
  }
}
