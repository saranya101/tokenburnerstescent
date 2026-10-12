import { spawnSync } from "node:child_process";

const scenarios = [
  {
    name: "Missing approval evidence is rejected",
    boundary: "ExecutionGateway cryptographic approval evidence gate; bank write spy remains at zero.",
    packageName: "@parlance/api",
    files: ["src/execution/gateway.test.ts"],
    pattern: "cryptographic evidence is missing",
    expected: ["blocks execution with zero bank writes when cryptographic evidence is missing"],
  },
  {
    name: "Approved plan and amount tampering is rejected",
    boundary: "WebAuthn approval payload binding before ApprovalEvidence or ExecutionRun creation.",
    packageName: "@parlance/api",
    files: ["src/webauthn/service.test.ts"],
    pattern: "rejects plan and goal mutations after challenge issuance|rejects amount substitution after challenge issuance",
    expected: [
      "rejects plan and goal mutations after challenge issuance",
      "rejects amount substitution after challenge issuance",
    ],
  },
  {
    name: "Beneficiary, account, and asset mutation is rejected",
    boundary: "WebAuthn plan binding and final ExecutionGateway exact-step comparison; gateway bank write spies remain at zero.",
    packageName: "@parlance/api",
    files: ["src/webauthn/service.test.ts", "src/execution/gateway.test.ts"],
    pattern: "rejects (beneficiary|source account) substitution after challenge issuance|rejects a post-approval BUY_ASSET (asset|funding account) change with zero bank writes",
    expected: [
      "rejects beneficiary substitution after challenge issuance",
      "rejects source account substitution after challenge issuance",
      "rejects a post-approval BUY_ASSET asset change with zero bank writes",
      "rejects a post-approval BUY_ASSET funding account change with zero bank writes",
    ],
  },
  {
    name: "Replay recovery produces one financial effect",
    boundary: "ExecutionService idempotency lookup and reconciliation after an accepted effect was not persisted locally.",
    packageName: "@parlance/api",
    files: ["src/orchestration/vertical-slice.test.ts"],
    pattern: "recovers a stale PENDING marker after acceptance persistence fails without a second bank effect",
    expected: ["recovers a stale PENDING marker after acceptance persistence fails without a second bank effect"],
  },
  {
    name: "Changed authoritative quote stops execution",
    boundary: "ExecutionService remainder simulation and state revalidation before the first bank write; write count remains zero.",
    packageName: "@parlance/api",
    files: ["src/orchestration/vertical-slice.test.ts"],
    pattern: "stops the bundle before any write when the approved asset quote has changed",
    expected: ["stops the bundle before any write when the approved asset quote has changed"],
  },
  {
    name: "Cross-customer resource access is rejected",
    boundary: "HTTP customer principal and ownership traversal before compilation, approval, or execution services are called.",
    packageName: "@parlance/api",
    files: ["src/security/customer-isolation.test.ts"],
    pattern: "does not let Bob operate on Alice's opaque IDs",
    expected: ["does not let Bob operate on Alice's opaque IDs"],
  },
  {
    name: "Model-generated executable actions are rejected",
    boundary: "ModelBackedIntentInterpreter schema boundary before grounding, confirmation, planning, or execution.",
    packageName: "@parlance/intent-engine",
    files: ["src/interpreter/interpreter.test.ts"],
    pattern: "rejects prompt injection with executable actions",
    expected: ["rejects prompt injection with executable actions"],
  },
  {
    name: "Risk and KYC refusal prevents banking writes",
    boundary: "Deterministic risk decision plus execution-time risk gate immediately before a bank write.",
    packageName: "@parlance/api",
    files: ["src/risk/evaluator.test.ts", "src/orchestration/vertical-slice.test.ts"],
    pattern: "blocks when KYC is blocked|blocks before the bank write when KYC or policy no longer permits execution",
    expected: [
      "blocks when KYC is blocked",
      "blocks before the bank write when KYC or policy no longer permits execution",
    ],
  },
];

const isolatedEnvironment = { ...process.env, NODE_ENV: "test" };
for (const name of [
  "TEST_DATABASE_URL", "DATABASE_URL", "DIRECT_URL",
  "TOKENHUB_API_KEY", "OPENAI_API_KEY",
  "MOCK_BANK_URL", "COMPILER_URL", "REDIS_URL",
  "PARLANCE_INTERNAL_API_TOKEN", "PARLANCE_OPS_API_TOKEN", "PARLANCE_BANK_API_TOKEN",
]) delete isolatedEnvironment[name];

const results = [];

console.log("PARLANCE SECURITY ASSURANCE");
console.log("===========================");
console.log("Isolation: in-memory fixtures; database and external-service configuration removed from child processes.\n");

for (const scenario of scenarios) {
  const command = [
    "--filter", scenario.packageName, "exec", "vitest", "run",
    ...scenario.files, "-t", scenario.pattern, "--reporter=json",
  ];
  const run = spawnSync("pnpm", command, {
    cwd: process.cwd(),
    env: isolatedEnvironment,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });

  let report;
  try {
    const jsonLine = run.stdout.trim().split("\n").findLast((line) => line.startsWith("{\"numTotalTestSuites\""));
    report = jsonLine === undefined ? undefined : JSON.parse(jsonLine);
  } catch {
    report = undefined;
  }

  const assertions = report?.testResults?.flatMap((suite) => suite.assertionResults ?? []) ?? [];
  const passedTitles = assertions.filter((test) => test.status === "passed").map((test) => test.title);
  const selectedFailures = assertions.filter((test) => test.status === "failed" && scenario.expected.includes(test.title));
  const missing = scenario.expected.filter((title) => !passedTitles.includes(title));
  const passed = run.status === 0 && report?.success === true && selectedFailures.length === 0 && missing.length === 0;

  results.push({ scenario, passed, missing, selectedFailures, run });
  console.log(`${passed ? "PASS" : "FAIL"}  ${scenario.name}`);
  console.log(`      Boundary: ${scenario.boundary}`);
  console.log(`      Checks: ${passed ? `${scenario.expected.length} passed` : `${scenario.expected.length} expected`} from ${scenario.files.join(", ")}`);
  if (!passed) {
    if (missing.length > 0) console.log(`      Missing or non-passing: ${missing.join("; ")}`);
    if (run.error) console.log(`      Runner error: ${run.error.message}`);
  }
}

const passed = results.filter((result) => result.passed).length;
const failed = results.length - passed;
const checks = results.reduce((total, result) => total + (result.passed ? result.scenario.expected.length : 0), 0);

console.log("\nSUMMARY");
console.log("=======");
console.log(`Scenarios: ${passed} passed, ${failed} failed`);
console.log(`Underlying focused checks passed: ${checks}`);
console.log("PostgreSQL concurrency guarantees: not exercised by this in-memory runner.");

if (failed > 0) {
  console.log("\nFailure details:");
  for (const result of results.filter((item) => !item.passed)) {
    const diagnostic = result.run.stderr.trim() || result.run.stdout.trim();
    console.log(`\n[${result.scenario.name}]\n${diagnostic || "No diagnostic output was produced."}`);
  }
  process.exitCode = 1;
}
