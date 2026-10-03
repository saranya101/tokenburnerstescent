import { IntentInterpreterError } from "../../interpreter/errors.js";
import { createTokenHubIntentInterpreter, type TokenHubConstraintProjectionDiagnostic } from "./index.js";
import { TokenHubConfigurationError } from "./config.js";

const INPUT = "Send USD 7000.00 to Nanyang Technological University";
const RUNS = 5;

async function main(): Promise<void> {
  if (process.env.TOKENHUB_API_KEY === undefined || process.env.TOKENHUB_API_KEY.trim().length === 0) {
    throw new TokenHubConfigurationError("TOKENHUB_API_KEY must be set before running the lock-in diagnostic.");
  }

  const projections: TokenHubConstraintProjectionDiagnostic[] = [];
  const interpreter = createTokenHubIntentInterpreter({
    developmentDiagnostics: {
      onConstraintProjection(diagnostic) {
        projections.push(diagnostic);
      },
    },
  });

  for (let run = 1; run <= RUNS; run += 1) {
    projections.length = 0;
    const started = performance.now();
    try {
      const draft = await interpreter.interpretUserRequest({ text: INPUT, userId: `tokenhub-lock-in-diagnostic-${run}` });
      const latestProjection = projections.at(-1);
      console.log(JSON.stringify({
        run,
        rawMaxLockInDays: latestProjection?.rawMaxLockInDays,
        projectedConstraints: latestProjection?.projectedConstraints,
        projectedMaxLockInDaysPresent: draft.constraints.some((constraint) => constraint.type === "MAX_LOCK_IN_DAYS"),
        validation: "VALID",
        validatedIntent: draft,
        durationMs: Math.round(performance.now() - started),
      }));
    } catch (error) {
      if (error instanceof IntentInterpreterError) {
        const latestProjection = projections.at(-1);
        console.log(JSON.stringify({
          run,
          rawMaxLockInDays: latestProjection?.rawMaxLockInDays,
          projectedConstraints: latestProjection?.projectedConstraints,
          projectedMaxLockInDaysPresent: Array.isArray(latestProjection?.projectedConstraints)
            && latestProjection.projectedConstraints.some((constraint) =>
              typeof constraint === "object" && constraint !== null && "type" in constraint
              && constraint.type === "MAX_LOCK_IN_DAYS"
            ),
          validation: error.code,
          validationIssues: error.validationIssues,
          modelDiagnostic: error.modelDiagnostic,
          durationMs: Math.round(performance.now() - started),
        }));
        continue;
      }
      throw error;
    }
  }
}

void main().catch((error: unknown) => {
  if (error instanceof TokenHubConfigurationError) {
    console.error(`TokenHub lock-in diagnostic configuration failed: ${error.message}`);
  } else {
    console.error("TokenHub lock-in diagnostic failed without a sanitized interpreter result.");
  }
  process.exitCode = 1;
});
