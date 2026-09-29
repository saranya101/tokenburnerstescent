import { expect, it } from "vitest";
import {
  IntentInterpreterError,
  type IntentInterpreter,
  type InterpretUserRequestInput,
  type TokenHubConfig,
} from "../../packages/intent-engine/src/index.js";
import { serializeBenchmarkReport } from "./report.js";
import {
  aggregateBenchmarkResults,
  calculateLatencyMetrics,
  createSafeBenchmarkConfiguration,
  runIntentBenchmark,
  selectBenchmarkFixtures,
} from "./runner.js";
import type { BenchmarkCaseResult, TokenHubIntentBenchmarkReport } from "./types.js";

class FakeInterpreter implements IntentInterpreter {
  readonly inputs: InterpretUserRequestInput[] = [];

  constructor(private readonly respond: (input: InterpretUserRequestInput) => Promise<unknown>) {}

  async interpretUserRequest(input: InterpretUserRequestInput) {
    this.inputs.push(input);
    return await this.respond(input) as never;
  }
}

function benchmarkCase(overrides: Partial<BenchmarkCaseResult> = {}): BenchmarkCaseResult {
  return {
    fixtureId: "fixture",
    dataset: "semantic",
    category: "REGRESSION",
    expectedDisposition: "VALID_INTENT",
    actualDisposition: "VALID_INTENT",
    status: "PASS",
    semanticAssertionFailures: [],
    safetyFindings: [],
    latencyMs: 10,
    ...overrides,
  };
}

const safeConfiguration = {
  provider: "TokenHub",
  model: "hy3",
  thinking: "disabled",
  promptVersion: "intent-v1",
  selection: "all",
} as const;

it("selects all, semantic, adversarial, and individual fixtures", () => {
  expect(selectBenchmarkFixtures("all")).toHaveLength(40);
  expect(selectBenchmarkFixtures("semantic")).toHaveLength(19);
  expect(selectBenchmarkFixtures("adversarial")).toHaveLength(21);
  const selected = selectBenchmarkFixtures("constraint-ignore-limit");
  expect(selected).toHaveLength(1);
  expect(selected[0]).toMatchObject({ dataset: "adversarial", evaluationCase: { id: "constraint-ignore-limit" } });
  expect(() => selectBenchmarkFixtures("not-a-fixture")).toThrow("Unknown intent evaluation fixture");
});

it("calculates midpoint median and nearest-rank p95 deterministically", () => {
  expect(calculateLatencyMetrics([40, 10, 30, 20])).toEqual({ minMs: 10, medianMs: 25, p95Ms: 40, maxMs: 40 });
  expect(calculateLatencyMetrics([9.6, 20.2, 30.4])).toEqual({ minMs: 10, medianMs: 20, p95Ms: 30, maxMs: 30 });
  expect(calculateLatencyMetrics([])).toEqual({ minMs: null, medianMs: null, p95Ms: null, maxMs: null });
});

it("aggregates pass rates, safety counts, reliability, and latency by case", () => {
  const results = [
    benchmarkCase(),
    benchmarkCase({
      fixtureId: "semantic-fail",
      status: "FAIL",
      actualDisposition: "INVALID_MODEL_OUTPUT",
      semanticAssertionFailures: [{ assertion: "forbidden.constraintTypes.MAX_LOCK_IN_DAYS", reason: "invented" }],
      safetyFindings: [{ kind: "EXECUTABLE_FIELD", path: "operations", message: "unsafe" }],
      latencyMs: 20,
    }),
    benchmarkCase({
      fixtureId: "adversarial-fail",
      dataset: "adversarial",
      status: "FAIL",
      semanticAssertionFailures: [{ assertion: "semantic.expected.requiredConstraints.0.MAX_TOTAL_COST", reason: "missing" }],
      safetyFindings: [
        { kind: "APPROVAL_OR_EXECUTION_AUTHORITY", path: "approved", message: "unsafe" },
        { kind: "CANONICAL_ID_FIELD", path: "assetId", message: "unsafe" },
      ],
      latencyMs: 30,
    }),
    benchmarkCase({
      fixtureId: "provider-fail",
      dataset: "adversarial",
      status: "FAIL",
      actualDisposition: "PROVIDER_ERROR",
      latencyMs: 40,
    }),
  ];
  expect(aggregateBenchmarkResults(results)).toEqual({
    semantic: { total: 2, passed: 1, failed: 1, passRatePercent: 50 },
    adversarial: { total: 2, passed: 0, failed: 2, passRatePercent: 0 },
    safety: {
      executableSemanticsViolations: 1,
      approvalExecutionAuthorityViolations: 1,
      canonicalIdGroundingBypassViolations: 1,
      inventedForbiddenHardConstraints: 1,
      missingRequiredHardConstraints: 1,
    },
    reliability: { invalidModelOutputCount: 1, providerModelErrorCount: 1 },
    latency: { minMs: 10, medianMs: 25, p95Ms: 40, maxMs: 40 },
  });
});

it("feeds an individual fixture to the interpreter exactly as written", async () => {
  const fixture = selectBenchmarkFixtures("regression-original-text-exact")[0];
  if (fixture === undefined) throw new Error("Fixture missing");
  const interpreter = new FakeInterpreter(async (input) => ({
    schemaVersion: "1",
    originalText: input.text,
    goal: { type: "DELIVER_MONEY", amount: { currency: "USD", minorUnits: "1000" }, recipientReference: "Casey" },
    constraints: [],
    preferences: [],
    references: [{ reference: "Casey", expectedEntityType: "BENEFICIARY" }],
  }));
  const times = [0, 0, 12, 12];
  const report = await runIntentBenchmark({
    interpreter,
    selection: fixture.evaluationCase.id,
    configuration: safeConfiguration,
    generatedAt: "2026-01-01T00:00:00.000Z",
    now: () => times.shift() ?? 12,
  });
  expect(interpreter.inputs).toEqual([{ text: fixture.evaluationCase.inputText, userId: `intent-live-benchmark:${fixture.evaluationCase.id}` }]);
  expect(report.cases[0]).toMatchObject({ status: "PASS", latencyMs: 12 });
});

it("counts provider errors and retains only sanitized diagnostics", async () => {
  const interpreter = new FakeInterpreter(async () => {
    throw new IntentInterpreterError(
      "MODEL_ERROR",
      "The intent model could not generate an interpretation.",
      undefined,
      { status: 503, code: "unavailable", type: "provider_error", message: "Request unavailable.", requestId: "req-safe" },
    );
  });
  const report = await runIntentBenchmark({
    interpreter,
    selection: "happy-deliver-money",
    configuration: safeConfiguration,
    now: () => 0,
  });
  expect(report.aggregate.reliability.providerModelErrorCount).toBe(1);
  expect(report.cases[0]).toMatchObject({
    status: "FAIL",
    actualDisposition: "PROVIDER_ERROR",
    diagnostic: { kind: "MODEL_ERROR", modelDiagnostic: { status: 503, requestId: "req-safe" } },
  });
});

it("classifies sanitized executable validation keys without needing a raw candidate", async () => {
  const interpreter = new FakeInterpreter(async () => {
    throw new IntentInterpreterError(
      "INVALID_MODEL_OUTPUT",
      "The intent model returned an invalid intent draft.",
      [{ path: [], code: "unrecognized_keys", message: "Unrecognized key", keys: ["operations"] }],
    );
  });
  const report = await runIntentBenchmark({
    interpreter,
    selection: "action-fx-convert-only",
    configuration: safeConfiguration,
    now: () => 0,
  });
  expect(report.cases[0]).toMatchObject({ status: "PASS", actualDisposition: "REJECT_EXECUTABLE_SEMANTICS" });
  expect(report.aggregate.safety.executableSemanticsViolations).toBe(1);
});

it("excludes and redacts secret configuration from JSON reports", () => {
  const tokenHubConfig: TokenHubConfig = {
    apiKey: "secret-benchmark-key",
    baseUrl: "https://example.invalid/v1",
    model: "hy3",
    thinking: "disabled",
  };
  const configuration = createSafeBenchmarkConfiguration(tokenHubConfig, "intent-v1", "semantic");
  const report: TokenHubIntentBenchmarkReport = {
    schemaVersion: "1",
    generatedAt: "2026-01-01T00:00:00.000Z",
    configuration,
    aggregate: aggregateBenchmarkResults([]),
    totalDurationMs: 0,
    cases: [benchmarkCase({ diagnostic: { kind: "MODEL_ERROR", message: "echo secret-benchmark-key" } })],
  };
  const serialized = serializeBenchmarkReport(report, [tokenHubConfig.apiKey]);
  expect(serialized).not.toContain("secret-benchmark-key");
  expect(serialized).not.toContain("apiKey");
  expect(serialized).not.toContain("Authorization");
  expect(serialized).toContain("[REDACTED]");
});
