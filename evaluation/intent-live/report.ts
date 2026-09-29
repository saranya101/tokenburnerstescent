import type { TokenHubIntentBenchmarkReport } from "./types.js";

export function serializeBenchmarkReport(
  report: TokenHubIntentBenchmarkReport,
  secrets: readonly string[] = [],
): string {
  return redactSecrets(`${JSON.stringify(report, null, 2)}\n`, secrets);
}

export function formatBenchmarkSummary(
  report: TokenHubIntentBenchmarkReport,
  secrets: readonly string[] = [],
): string {
  const { semantic, adversarial, safety, reliability, latency } = report.aggregate;
  const failedCases = report.cases.filter((result) => result.status === "FAIL");
  const lines = [
    "Intent semantic:",
    `  ${semantic.passed} / ${semantic.total} passed (${formatRate(semantic.passRatePercent)})`,
    "",
    "Adversarial:",
    `  ${adversarial.passed} / ${adversarial.total} passed (${formatRate(adversarial.passRatePercent)})`,
    "",
    "Safety:",
    `  Executable violations: ${safety.executableSemanticsViolations}`,
    `  Approval violations: ${safety.approvalExecutionAuthorityViolations}`,
    `  Canonical-ID / grounding-bypass violations: ${safety.canonicalIdGroundingBypassViolations}`,
    `  Invented forbidden constraints: ${safety.inventedForbiddenHardConstraints}`,
    `  Missing required constraints: ${safety.missingRequiredHardConstraints}`,
    "",
    "Reliability:",
    `  INVALID_MODEL_OUTPUT: ${reliability.invalidModelOutputCount}`,
    `    expected: ${reliability.expectedInvalidModelOutputCount}`,
    `    unexpected: ${reliability.unexpectedInvalidModelOutputCount}`,
    `  Provider/model errors: ${reliability.providerModelErrorCount}`,
    "",
    "Latency:",
    `  min: ${formatLatency(latency.minMs)}`,
    `  median: ${formatLatency(latency.medianMs)}`,
    `  p95: ${formatLatency(latency.p95Ms)}`,
    `  max: ${formatLatency(latency.maxMs)}`,
    "",
    "Failed cases:",
    ...(failedCases.length === 0 ? ["  none"] : failedCases.map((result) => `  - ${result.fixtureId}`)),
  ];
  return redactSecrets(lines.join("\n"), secrets);
}

function formatRate(value: number | null): string {
  return value === null ? "n/a" : `${value.toFixed(1)}%`;
}

function formatLatency(value: number | null): string {
  return value === null ? "n/a" : `${(value / 1000).toFixed(1)}s`;
}

function redactSecrets(value: string, secrets: readonly string[]): string {
  return secrets.reduce((redacted, secret) =>
    secret.length === 0 ? redacted : redacted.replaceAll(secret, "[REDACTED]"), value
  );
}
