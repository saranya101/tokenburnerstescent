import { IntentInterpreterError } from "../../interpreter/errors.js";
import { TokenHubConfigurationError } from "./config.js";
import { createTokenHubIntentInterpreter } from "./index.js";
import { assertTokenHubSemanticSmokeDraft, TOKENHUB_SMOKE_INPUT, TokenHubSemanticSmokeError } from "./smoke-fixture.js";

async function main(): Promise<void> {
  // Fail before creating a provider client or making any request when credentials are absent.
  if (process.env.TOKENHUB_API_KEY === undefined || process.env.TOKENHUB_API_KEY.trim().length === 0) {
    throw new TokenHubConfigurationError("TOKENHUB_API_KEY must be set before running the TokenHub smoke test.");
  }

  // This is deliberately the factory/interpreter path, not a direct provider call.
  const interpreter = createTokenHubIntentInterpreter();
  const draft = await interpreter.interpretUserRequest({ text: TOKENHUB_SMOKE_INPUT, userId: "tokenhub-smoke" });
  console.log("Validated IntentDraftV1:");
  console.log(JSON.stringify(draft, null, 2));
  assertTokenHubSemanticSmokeDraft(draft);
  console.log("TokenHub semantic smoke test passed.");
}

void main().catch((error: unknown) => {
  if (error instanceof TokenHubConfigurationError) {
    console.error(`TokenHub smoke test configuration failed: ${error.message}`);
  } else if (error instanceof TokenHubSemanticSmokeError) {
    console.error(`TokenHub semantic smoke test failed: ${error.message}`);
  } else if (error instanceof IntentInterpreterError) {
    // Interpreter errors are sanitized and contain no SDK/provider internals.
    console.error(`TokenHub smoke test failed [${error.code}]: ${error.message}`);
    if (error.modelDiagnostic !== undefined) {
      console.error(`TokenHub provider diagnostic: ${JSON.stringify(error.modelDiagnostic)}`);
    }
    if (error.code === "INVALID_MODEL_OUTPUT") {
      console.error(`IntentDraft validation issues: ${JSON.stringify(error.validationIssues ?? [])}`);
    }
  } else {
    // Do not print unknown errors because they may include provider headers or credentials.
    console.error("TokenHub smoke test failed before a validated intent draft was returned.");
  }
  process.exitCode = 1;
});
