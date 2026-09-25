import type { IntentValidationIssue } from "./types.js";

export type IntentInterpreterErrorCode = "EMPTY_INPUT" | "MODEL_ERROR" | "INVALID_MODEL_OUTPUT";

export class IntentInterpreterError extends Error {
  readonly name = "IntentInterpreterError";

  constructor(
    readonly code: IntentInterpreterErrorCode,
    message: string,
    readonly validationIssues?: readonly IntentValidationIssue[],
  ) {
    super(message);
  }
}
