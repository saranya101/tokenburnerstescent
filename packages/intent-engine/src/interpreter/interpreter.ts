import { IntentDraftV1, type IntentDraftV1 as IntentDraft } from "@parlance/contracts";
import { INTENT_PROMPT_VERSION, INTENT_V1_SYSTEM_PROMPT } from "../prompts/intent-v1.js";
import { IntentInterpreterError } from "./errors.js";
import type { IntentInterpreter, IntentModelClient, InterpretUserRequestInput, IntentValidationIssue } from "./types.js";

function validationIssues(error: { issues: readonly { path?: readonly PropertyKey[]; code: string; message: string; keys?: unknown }[] }): IntentValidationIssue[] {
  return error.issues.map(({ path, code, message, keys }) => {
    const safeKeys = Array.isArray(keys) && keys.every((key): key is string => typeof key === "string")
      ? keys
      : undefined;
    return {
      path: (path ?? []).filter((part): part is string | number => typeof part === "string" || typeof part === "number"),
      code,
      message,
      ...(safeKeys === undefined ? {} : { keys: safeKeys }),
    };
  });
}

/** Converts raw language through an injected model client into a validated intent draft. */
export class ModelBackedIntentInterpreter implements IntentInterpreter {
  constructor(private readonly modelClient: IntentModelClient) {}

  async interpretUserRequest(input: InterpretUserRequestInput): Promise<IntentDraft> {
    if (input.text.trim().length === 0) {
      throw new IntentInterpreterError("EMPTY_INPUT", "User input must not be empty.");
    }

    let candidate: unknown;
    try {
      candidate = await this.modelClient.generateIntent({
        text: input.text,
        systemPrompt: INTENT_V1_SYSTEM_PROMPT,
        promptVersion: INTENT_PROMPT_VERSION,
      });
    } catch {
      // Provider errors may contain credentials or implementation details.
      throw new IntentInterpreterError("MODEL_ERROR", "The intent model could not generate an interpretation.");
    }

    // Deliberately preserve unknown keys so IntentDraftV1's strict schema rejects them.
    const completeCandidate = isRecord(candidate)
      ? { ...candidate, originalText: input.text }
      : candidate;
    const parsed = IntentDraftV1.safeParse(completeCandidate);
    if (!parsed.success) {
      throw new IntentInterpreterError(
        "INVALID_MODEL_OUTPUT",
        "The intent model returned an invalid intent draft.",
        validationIssues(parsed.error),
      );
    }
    return parsed.data;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
