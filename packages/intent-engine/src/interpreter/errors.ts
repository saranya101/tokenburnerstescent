import type { IntentValidationIssue, ModelClientDiagnostic } from "./types.js";

export type IntentInterpreterErrorCode = "EMPTY_INPUT" | "MODEL_ERROR" | "INVALID_MODEL_OUTPUT" | "DEMO_REQUEST_UNSUPPORTED" | "DEMO_FX_UNAVAILABLE" | "DEMO_BILL_UNAVAILABLE";

export class IntentInterpreterError extends Error {
  readonly name = "IntentInterpreterError";

  constructor(
    readonly code: IntentInterpreterErrorCode,
    message: string,
    readonly validationIssues?: readonly IntentValidationIssue[],
    readonly modelDiagnostic?: ModelClientDiagnostic,
  ) {
    super(message);
  }
}
