import { describe, expect, it } from "vitest";
import { buildOpsRuns, safeJson, type OpsAuditRow, type OpsRunRow } from "./read-model.js";

const at = (minute: number) => new Date(`2026-09-29T10:${String(minute).padStart(2, "0")}:00.000Z`);

function row(options: { execution?: "COMPLETED" | "PAUSED" | "REAPPROVAL_REQUIRED"; executionError?: string; evidence?: boolean; challenge?: "ISSUED" | "CONSUMED" | "REVOKED"; goal?: boolean; plan?: boolean } = {}): OpsRunRow {
  const withGoal = options.goal ?? true;
  const withPlan = options.plan ?? withGoal;
  const evidence = options.evidence ?? Boolean(options.execution);
  const approval = options.execution || options.challenge === "CONSUMED" ? [{
    id: "approval-abcdefghijklmnopqrstuvwxyz", method: "PASSKEY", approvedAt: at(3), bankStateVersion: 7, traceId: "trace-approval-abcdefghijklmnopqrstuvwxyz",
    evidence: evidence ? { id: "evidence-abcdefghijklmnopqrstuvwxyz", userVerified: true } : null,
  }] : [];
  const executionRuns = options.execution ? [{
    id: "execution-abcdefghijklmnopqrstuvwxyz", status: options.execution, startedStateVersion: 7, finalStateVersion: options.execution === "COMPLETED" ? 8 : null,
    goalOutcome: { achieved: options.execution === "COMPLETED", summary: "Recorded outcome" }, traceId: "trace-execution-abcdefghijklmnopqrstuvwxyz", createdAt: at(4), updatedAt: at(5), userId: "user", planId: "plan", approvalId: "approval",
    steps: [{
      id: "execution-step", executionRunId: "execution", planStepId: "plan-step", status: options.execution === "COMPLETED" ? "SETTLED" : "UNKNOWN", idempotencyKey: "hidden-from-view", bankReference: options.execution === "COMPLETED" ? "bank-reference-abcdefghijklmnopqrstuvwxyz" : null,
      errorCode: options.execution === "COMPLETED" ? null : options.executionError ?? "STATE_CHANGED", resultingStateVersion: options.execution === "COMPLETED" ? 8 : null, traceId: "trace", createdAt: at(4), updatedAt: at(5),
      planStep: { id: "plan-step", planId: "plan", stepKey: "step-transfer-abcdefghijklmnopqrstuvwxyz", sequence: 0, action: "TRANSFER", dependsOn: [], reversible: false, parameters: { amount: { currency: "USD", minorUnits: "700000" } }, createdAt: at(2) },
    }],
  }] : [];
  const financialPlans = withPlan ? [{
    id: "plan-abcdefghijklmnopqrstuvwxyz", goalContractRowId: "goal-row", goalContractKey: "goal-key", status: "READY", schemaVersion: "1", goalContractVersion: 1,
    bankStateVersion: 7, compilerVersion: "1.0.0", policyVersion: "1.0.0", operationLibraryVersion: "1.0.0", validity: { requiredQuoteIds: ["quote-abcdefghijklmnopqrstuvwxyz"] },
    projectedOutcome: { warnings: [] }, planHash: "b".repeat(64), traceId: "trace-plan-abcdefghijklmnopqrstuvwxyz", createdAt: at(2), updatedAt: at(2),
    steps: [{ id: "plan-step", planId: "plan", stepKey: "step-transfer-abcdefghijklmnopqrstuvwxyz", sequence: 0, action: "TRANSFER", dependsOn: [], reversible: false, parameters: { amount: { currency: "USD", minorUnits: "700000" }, beneficiaryId: "ben-ntu" }, createdAt: at(2) }],
    approvals: approval,
    webAuthnChallenges: options.challenge ? [{ id: "challenge-record-abcdefghijklmnopqrstuvwxyz", userId: "user", purpose: "APPROVAL", challenge: "forbidden challenge bytes", userHandle: null, expectedRpId: "localhost", expectedOrigin: "http://localhost:3000", status: options.challenge, financialPlanId: "plan", approvalPayload: null, approvalPayloadHash: null, expiresAt: at(9), consumedAt: options.challenge === "CONSUMED" ? at(3) : null, revokedAt: null, createdAt: at(3) }] : [],
    executionRuns,
  }] : [];
  const goalContracts = withGoal ? [{
    id: "goal-row-abcdefghijklmnopqrstuvwxyz", contractKey: "goal-key-abcdefghijklmnopqrstuvwxyz", version: 1, userId: "user", sourceIntentDraftId: "candidate", status: "CONFIRMED", schemaVersion: "1",
    goalPayload: { type: "DELIVER_MONEY", amount: { currency: "USD", minorUnits: "700000" }, recipientId: "ben-ntu" }, preferences: [], contractHash: "a".repeat(64), createdAt: at(1), confirmedAt: at(1), updatedAt: at(1),
    constraints: [], entityBindings: [{ id: "binding", goalContractId: "goal", reference: "NTU", entityType: "BENEFICIARY", entityId: "ben-ntu", resolutionMethod: "EXACT", confidence: null, confirmed: true, createdAt: at(1) }], financialPlans,
  }] : [];
  return {
    id: "candidate-abcdefghijklmnopqrstuvwxyz", userId: "manual-user-1790040222", conversationId: "conversation", schemaVersion: "1", status: withGoal ? "CONFIRMED" : "AWAITING_GOAL_CONFIRMATION", createdAt: at(0), updatedAt: at(0),
    payload: { kind: "GOAL_CANDIDATE_V1", intentDraft: { originalText: "Send USD 7000.00 to NTU", goal: { type: "DELIVER_MONEY", amount: { currency: "USD", minorUnits: "700000" }, recipientReference: "NTU" } }, candidate: { goal: { type: "DELIVER_MONEY", amount: { currency: "USD", minorUnits: "700000" }, recipientId: "ben-ntu" }, entityBindings: [{ reference: "NTU", entityType: "BENEFICIARY", entityId: "ben-ntu", resolutionMethod: "EXACT" }] } },
    conversation: { messages: [{ content: "Send USD 7000.00 to NTU", traceId: "trace-request-abcdefghijklmnopqrstuvwxyz", createdAt: at(0) }] }, goalContracts,
  } as unknown as OpsRunRow;
}

function audit(minute: number, payload: unknown = {}): OpsAuditRow {
  return { id: `audit-${minute}-abcdefghijklmnopqrstuvwxyz`, eventType: minute === 1 ? "GOAL_CONFIRMED" : "PLAN_COMPILED", aggregateType: "GoalContract", aggregateId: "goal-key-abcdefghijklmnopqrstuvwxyz", traceId: "trace-request-abcdefghijklmnopqrstuvwxyz", payload, occurredAt: at(minute) } as OpsAuditRow;
}

function semanticAudit(eventType: "SEMANTIC_VALIDATION_PASSED" | "SEMANTIC_VALIDATION_FAILED", payload: unknown): OpsAuditRow {
  return { id: `audit-semantic-${eventType}`, eventType, aggregateType: "IntentDraftRecord", aggregateId: "candidate-abcdefghijklmnopqrstuvwxyz", traceId: "trace-request-abcdefghijklmnopqrstuvwxyz", payload, occurredAt: at(1) } as OpsAuditRow;
}

describe("ops read model", () => {
  it("projects bundle meaning, proof, and ownership without exposing internal item IDs in summaries", () => {
    const bundleRun = row();
    const plans = bundleRun.goalContracts[0]!.financialPlans;
    plans[0]!.satisfactionProof = { bundleId: "bundle-key-abcdefghijklmnopqrstuvwxyz", bundleContractHash: "c".repeat(64), itemCoverage: [{ itemId: "item-1", satisfiedByStepIds: ["step-transfer-abcdefghijklmnopqrstuvwxyz"] }], allItemsSatisfied: true, allHardConstraintsSatisfied: true, allExplicitDependenciesSatisfied: true, allIrreversibleStepsJustified: true };
    bundleRun.goalContracts = [];
    bundleRun.goalBundleContracts = [{
      id: "bundle-row-abcdefghijklmnopqrstuvwxyz", bundleKey: "bundle-key-abcdefghijklmnopqrstuvwxyz", version: 1, userId: "user", sourceIntentDraftId: bundleRun.id,
      status: "CONFIRMED", schemaVersion: "1", contractHash: "c".repeat(64), createdAt: at(1), confirmedAt: at(1), updatedAt: at(1), financialPlans: plans,
      payload: { schemaVersion: "1", bundleId: "bundle-key-abcdefghijklmnopqrstuvwxyz", bundleVersion: 1, contractHash: "c".repeat(64), items: [{ itemId: "item-1", goal: { type: "DELIVER_MONEY", amount: { currency: "USD", minorUnits: "30000" }, recipientId: "ben-john" }, constraints: [], preferences: [], bindings: [] }], globalConstraints: [], explicitDependencies: [] },
    }];
    bundleRun.payload = { kind: "GOAL_BUNDLE_CANDIDATE_V1", originalText: "Send John USD 300", candidate: { schemaVersion: "1", items: [{ itemId: "item-1", goal: { type: "DELIVER_MONEY", amount: { currency: "USD", minorUnits: "30000" }, recipientId: "ben-john" }, constraints: [], preferences: [], bindings: [] }], globalConstraints: [], explicitDependencies: [] } };
    const validation = { id: "audit-bundle-validation", eventType: "BUNDLE_SEMANTIC_VALIDATION_PASSED", aggregateType: "IntentDraftRecord", aggregateId: bundleRun.id, traceId: "trace-request-abcdefghijklmnopqrstuvwxyz", payload: { decision: "PASS", mismatches: [] }, occurredAt: at(1) } as OpsAuditRow;
    const run = buildOpsRuns([bundleRun], [validation])[0]!;
    expect(run.stages.interpretation).toMatchObject({ state: "COMPLETE", summary: "1 financial intents interpreted", detail: { interpretationType: "BUNDLE", itemCount: 1 } });
    expect(run.stages.semanticValidation.state).toBe("COMPLETE");
    expect(run.stages.confirmedGoal).toMatchObject({ state: "COMPLETE", detail: { ownerType: "BUNDLE", bundleVersion: 1 } });
    expect(run.stages.plan.detail).toMatchObject({ bankStateVersion: 7, satisfactionProof: { allItemsSatisfied: true, allHardConstraintsSatisfied: true } });
    expect(run.stages.confirmedGoal.summary).not.toContain("item-1");
  });

  it("represents a completed run without exposing private operation data", () => {
    const run = buildOpsRuns([row({ execution: "COMPLETED" })], [semanticAudit("SEMANTIC_VALIDATION_PASSED", { decision: "PASS", mismatches: [] }), audit(2), audit(1)])[0]!;
    expect(run.stages.semanticValidation).toMatchObject({ state: "COMPLETE" });
    expect(run.stages.authorization).toMatchObject({ state: "COMPLETE", detail: { method: "PASSKEY", userVerified: true, approvalEvidence: "present" } });
    expect(run.stages.execution).toMatchObject({ state: "COMPLETE" });
    expect(run.stages.bankResult).toMatchObject({ state: "COMPLETE", detail: { reconciliation: "confirmed with bank" } });
    expect(JSON.stringify(run)).not.toContain("idempotencyKey");
    expect(run.audit.map((event) => event.occurredAt)).toEqual([at(1).toISOString(), at(1).toISOString(), at(2).toISOString()]);
  });

  it("shows safe voice transcript provenance and the customer edit in the input stage", () => {
    const voice = row({ goal: false, plan: false });
    voice.conversation.messages[0] = {
      ...voice.conversation.messages[0]!, content: "Send John USD 3000", inputMode: "VOICE",
      inputMetadata: { rawTranscript: "Send John USD 300", provider: "browser-web-speech", transcribedAt: "2026-10-03T10:00:00.000Z", edited: true },
    };
    const run = buildOpsRuns([voice], [])[0]!;
    expect(run.stages.request.detail).toMatchObject({ input: "Voice", transcript: "Send John USD 300", submittedText: "Send John USD 3000", customerEdit: "Edited", provider: "browser-web-speech" });
    expect(JSON.stringify(run)).not.toMatch(/audio|blob/iu);
  });

  it("terminates a rejected trace at semantic validation with no financial authority", () => {
    const rejected = row({ goal: false, plan: false }); rejected.status = "SEMANTIC_VALIDATION_FAILED"; rejected.payload = { kind: "SEMANTIC_VALIDATION_REJECTED_V1", semanticValidation: { decision: "FAIL" } };
    const run = buildOpsRuns([rejected], [semanticAudit("SEMANTIC_VALIDATION_FAILED", { decision: "FAIL", mismatches: [{ code: "MONEY_MISMATCH", field: "goal.amount" }] })])[0]!;
    expect(run.overallState).toBe("SEMANTIC_VALIDATION_FAILED"); expect(run.stages.semanticValidation).toMatchObject({ state: "STOPPED" });
    expect(run.stages.confirmedGoal.state).toBe("NOT_REACHED"); expect(run.stages.plan.state).toBe("NOT_REACHED"); expect(run.stages.authorization.state).toBe("NOT_REACHED"); expect(run.stages.execution.state).toBe("NOT_REACHED"); expect(run.stages.bankResult.state).toBe("NOT_REACHED");
  });

  it("stops candidate-only runs at meaning confirmation and creates no fake later data", () => {
    const run = buildOpsRuns([row({ goal: false, plan: false })], [])[0]!;
    expect(run.stages.confirmedGoal).toMatchObject({ state: "WAITING" });
    expect(run.stages.plan).toEqual({ state: "NOT_REACHED", summary: "Meaning not yet confirmed" });
    expect(run.stages.authorization).toEqual({ state: "NOT_REACHED", summary: "No plan to authorize" });
    expect(run.stages.execution.detail).toBeUndefined();
    expect(run.stages.bankResult.detail).toBeUndefined();
  });

  it.each(["PAUSED", "REAPPROVAL_REQUIRED"] as const)("shows %s as a stopped execution", (state) => {
    const run = buildOpsRuns([row({ execution: state })], [])[0]!;
    expect(run.overallState).toBe(state);
    expect(run.stages.execution.state).toBe("STOPPED");
    expect(run.stages.bankResult.state).toBe("STOPPED");
    if (state === "REAPPROVAL_REQUIRED") expect(run.stages.execution.summary).toContain("prior authorization cannot continue");
  });

  it("distinguishes an unknown bank outcome from a definite stopped execution", () => {
    const run = buildOpsRuns([row({ execution: "PAUSED", executionError: "BANK_LOOKUP_UNAVAILABLE" })], [])[0]!;
    expect(run.stages.execution).toMatchObject({ state: "WAITING", summary: "Bank outcome reconciliation required" });
    expect(run.stages.execution.detail?.steps).toEqual([expect.objectContaining({ decision: "reconciling" })]);
    expect(run.stages.bankResult).toMatchObject({ state: "WAITING", detail: { reconciliation: "confirming transaction status" } });
  });

  it("fails closed in the view when ApprovalEvidence is missing", () => {
    const run = buildOpsRuns([row({ challenge: "CONSUMED", evidence: false })], [])[0]!;
    expect(run.stages.authorization).toMatchObject({ state: "FAILED", detail: { userVerified: false, approvalEvidence: "missing" } });
    expect(run.stages.execution).toEqual({ state: "NOT_REACHED", summary: "Authorization not complete" });
  });

  it("redacts forbidden keys and credential-shaped string values", () => {
    const value = safeJson({ authorization: "Bearer abc", publicKey: "blob", planHash: "a".repeat(64), planId: "plan-abcdefghijklmnopqrstuvwxyz", nested: { prompt: "private", safe: "kept", note: "Bearer xyz" } });
    expect(value).toEqual({ authorization: "[redacted]", publicKey: "[redacted]", planHash: "aaaaaaaaaaaa…aaaaaaaa", planId: "plan-abc…uvwxyz", nested: { prompt: "[redacted]", safe: "kept", note: "[redacted]" } });
  });
});
