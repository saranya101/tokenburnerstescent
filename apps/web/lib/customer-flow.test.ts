import { ApprovalV1, ExecutionResultV1, FinancialPlanV1, GoalBundleContractV1, GoalContractV1 } from "@parlance/contracts";
import { beforeEach, expect, it, vi } from "vitest";
import { CustomerFlowController, type CustomerFlowState } from "./customer-flow";
import type { AuthenticationCredentialJSON, GoalCandidate, ParlanceApi, RegistrationCredentialJSON } from "./parlance-api";
import { PasskeyCancelledError, type PasskeyClient } from "./passkey";

const candidate: GoalCandidate = {
  schemaVersion: "1", goal: { type: "DELIVER_MONEY", amount: { currency: "USD", minorUnits: "500000" }, recipientId: "beneficiary-ntu" },
  constraints: [], preferences: [], entityBindings: [{ schemaVersion: "1", reference: "NTU", entityType: "BENEFICIARY", entityId: "beneficiary-ntu", resolutionMethod: "EXACT", confirmed: false }],
};
const goal = GoalContractV1.parse({ ...candidate, id: "goal-1", userId: "user-1", version: 1, sourceIntentDraftId: "candidate-1", status: "CONFIRMED", contractHash: "goal-hash-0000001", createdAt: "2026-09-28T00:00:00.000Z", confirmedAt: "2026-09-28T00:01:00.000Z", entityBindings: candidate.entityBindings.map((item) => ({ ...item, confirmed: true })) });
const bundle = GoalBundleContractV1.parse({
  schemaVersion: "1", bundleId: "bundle-1", bundleVersion: 1, contractHash: "b".repeat(64),
  items: [
    { itemId: "item-1", goal: { type: "DELIVER_MONEY", amount: { currency: "USD", minorUnits: "30000" }, recipientId: "beneficiary-john" }, constraints: [], preferences: [], bindings: [{ schemaVersion: "1", reference: "John", entityType: "BENEFICIARY", entityId: "beneficiary-john", resolutionMethod: "USER_CONFIRMED", confirmed: true }] },
    { itemId: "item-2", goal: { type: "ACQUIRE_ASSET", assetId: "asset-aapl", quantity: "1" }, constraints: [], preferences: [], bindings: [{ schemaVersion: "1", reference: "Apple", entityType: "ASSET", entityId: "asset-aapl", resolutionMethod: "EXACT", confirmed: true }] },
  ], globalConstraints: [], explicitDependencies: [],
});
const bundleCandidate = { schemaVersion: bundle.schemaVersion, items: bundle.items.map((item) => ({ ...item, bindings: item.bindings.map((binding) => ({ ...binding, confirmed: false })) })), globalConstraints: bundle.globalConstraints, explicitDependencies: bundle.explicitDependencies };
const plan = FinancialPlanV1.parse({
  schemaVersion: "1", id: "plan-1", goalContractId: goal.id, goalContractVersion: 1, bankStateVersion: 7,
  compilerVersion: "test", policyVersion: "test", operationLibraryVersion: "test", planHash: "plan-hash-0000001",
  steps: [
    { id: "fx-1", sequence: 0, dependsOn: [], reversible: false, action: "FX_CONVERT", parameters: { sourceAccountId: "sgd", destinationAccountId: "usd", sourceMoney: { currency: "SGD", minorUnits: "690000" }, targetCurrency: "USD", quoteId: "quote-1" } },
    { id: "transfer-1", sequence: 1, dependsOn: ["fx-1"], reversible: false, action: "TRANSFER", parameters: { sourceAccountId: "usd", beneficiaryId: "beneficiary-ntu", amount: { currency: "USD", minorUnits: "500000" } } },
  ],
  validity: { requiredQuoteIds: ["quote-1"] }, projectedOutcome: { goalSatisfied: true, deliveredMoney: { currency: "USD", minorUnits: "500000" }, acquiredAssets: [], paidObligationIds: [], projectedAvailableBalances: [], warnings: [] },
});
const bundlePlan = FinancialPlanV1.parse({ ...plan, id: "bundle-plan", goalContractId: bundle.bundleId, planHash: "bundle-plan-hash-1" });
const refreshedPlan = FinancialPlanV1.parse({ ...plan, id: "plan-2", planHash: "plan-hash-0000002" });
const pending = ExecutionResultV1.parse({ schemaVersion: "1", executionId: "execution-1", planId: plan.id, status: "PENDING", startedStateVersion: 7, steps: [], goalOutcome: { achieved: false, summary: "Waiting for execution." } });
const completed = ExecutionResultV1.parse({ schemaVersion: "1", executionId: "execution-1", planId: plan.id, status: "COMPLETED", startedStateVersion: 7, finalStateVersion: 9, steps: plan.steps.map((step) => ({ stepId: step.id, status: "SETTLED", idempotencyKey: `key-${step.id}`, bankReference: `bank-${step.id}` })), goalOutcome: { achieved: true, summary: "Requested funds were delivered.", deliveredMoney: { currency: "USD", minorUnits: "500000" } } });
const unknown = ExecutionResultV1.parse({ ...completed, status: "UNKNOWN", goalOutcome: { achieved: false, summary: "Execution stopped safely." }, steps: [{ stepId: "fx-1", status: "UNKNOWN", idempotencyKey: "key-fx", errorCode: "STATE_CHANGED" }] });
const credential: AuthenticationCredentialJSON = { id: "credential-1", rawId: "credential-1", type: "public-key", response: { clientDataJSON: "client", authenticatorData: "authenticator", signature: "signature" }, clientExtensionResults: {} };
const registration: RegistrationCredentialJSON = { id: "credential-1", rawId: "credential-1", type: "public-key", response: { clientDataJSON: "client", attestationObject: "attestation", transports: [] }, clientExtensionResults: {} };

function setup(overrides: Partial<ParlanceApi> = {}, passkeyResult: AuthenticationCredentialJSON | Error = credential) {
  const api = {
    sendMessage: vi.fn().mockResolvedValue({ status: "AWAITING_GOAL_CONFIRMATION", candidateId: "candidate-1", goalCandidate: candidate }),
    answerClarification: vi.fn().mockResolvedValue({ status: "AWAITING_GOAL_CONFIRMATION", candidateId: "candidate-1", goalCandidate: candidate }),
    confirmGoal: vi.fn().mockResolvedValue(goal), compileGoal: vi.fn().mockResolvedValue({ schemaVersion: "1", status: "SAT", plan }),
    approvalOptions: vi.fn().mockResolvedValue({ challengeId: "challenge-1", options: { challenge: "challenge" } }),
    verifyApproval: vi.fn().mockResolvedValue({ approval: ApprovalV1.parse({ schemaVersion: "1", id: "approval-1", userId: "user-1", goalContractId: goal.id, goalContractVersion: 1, goalContractHash: goal.contractHash, financialPlanId: plan.id, financialPlanHash: plan.planHash, bankStateVersion: 7, method: "PASSKEY", approvedAt: "2026-09-28T00:02:00.000Z", expiresAt: "2026-09-28T00:12:00.000Z", signatureReference: "evidence-1" }), execution: pending }),
    runExecution: vi.fn().mockResolvedValue(completed), executionDetail: vi.fn().mockResolvedValue({ state: "COMPLETED", result: completed }), ...overrides,
  } as unknown as ParlanceApi;
  const passkey: PasskeyClient = { request: vi.fn().mockImplementation(() => passkeyResult instanceof Error ? Promise.reject(passkeyResult) : Promise.resolve(passkeyResult)), register: vi.fn().mockResolvedValue(registration) };
  const states: CustomerFlowState[] = []; const flow = new CustomerFlowController(api, passkey, (state) => states.push(state));
  return { api, passkey, flow, states };
}

async function reachPlan(values: ReturnType<typeof setup>) { await values.flow.submitMessage("Send NTU USD 5,000"); await values.flow.confirmMeaning(); expect(values.flow.state.phase).toBe("PLAN_REVIEW"); }

beforeEach(() => vi.clearAllMocks());

it("exposes and executes the hook-facing confirmMeaning method on the real controller runtime", async () => {
  const values = setup();
  expect(typeof values.flow.confirmMeaning).toBe("function");
  expect("confirmGoal" in values.flow).toBe(false);
  await values.flow.submitMessage("Send USD 7000.00 to NTU");
  await values.flow.confirmMeaning();
  expect(values.api.confirmGoal).toHaveBeenCalledOnce();
  expect(values.api.confirmGoal).toHaveBeenCalledWith("candidate-1");
});

it("submits edited voice text through the exact existing message call without granting later authority", async () => {
  const values = setup(); const voice = { inputMode: "VOICE" as const, voice: { rawTranscript: "Send John USD 300", provider: "browser-web-speech", transcribedAt: "2026-10-03T10:00:00.000Z" } };
  await values.flow.submitMessage("Send John USD 3000", voice);
  expect(values.api.sendMessage).toHaveBeenCalledWith("Send John USD 3000", voice);
  expect(values.flow.state.phase).toBe("GOAL_REVIEW");
  expect(values.api.confirmGoal).not.toHaveBeenCalled(); expect(values.api.compileGoal).not.toHaveBeenCalled(); expect(values.api.approvalOptions).not.toHaveBeenCalled(); expect(values.api.runExecution).not.toHaveBeenCalled();
});

it("runs the real multi-step customer sequence through completion", async () => {
  const values = setup(); await reachPlan(values); await values.flow.authorizeAndExecute();
  expect(values.flow.state).toMatchObject({ phase: "COMPLETED", result: { status: "COMPLETED", steps: [{ stepId: "fx-1" }, { stepId: "transfer-1" }] } });
  expect(values.api.approvalOptions).toHaveBeenCalledWith(plan.id); expect(values.api.verifyApproval).toHaveBeenCalledWith(plan.id, "challenge-1", credential); expect(values.api.runExecution).toHaveBeenCalledWith("execution-1");
});

it("continues a backend clarification through its persisted identifier without resending the request", async () => {
  const clarification = { reason: "AMBIGUOUS_ENTITY", field: "recipientReference", originalReference: "John", questionKey: "clarify.entity.ambiguous", options: [{ entityId: "ben-john-tan", entityType: "BENEFICIARY" as const, displayName: "John Tan" }] };
  const values = setup({ sendMessage: vi.fn().mockResolvedValueOnce({ status: "NEEDS_CLARIFICATION", clarificationId: "clarification-1", clarifications: [clarification] }) });
  await values.flow.submitMessage("Send money to John"); expect(values.flow.state.phase).toBe("CLARIFICATION");
  await values.flow.answerClarification(clarification, clarification.options[0]!); expect(values.flow.state.phase).toBe("GOAL_REVIEW");
  expect(values.api.sendMessage).toHaveBeenCalledOnce(); expect(values.api.answerClarification).toHaveBeenCalledWith("clarification-1", { selectedCandidateId: "ben-john-tan" });
  expect(values.flow.state).toMatchObject({ answers: [{ reference: "John", answer: "John Tan" }] });
});

it("sends typed clarification text for server-side grounding and never supplies a binding", async () => {
  const clarification = { reason: "ENTITY_NOT_FOUND", field: "preferences[0].accountReference", originalReference: "my SGD account", questionKey: "clarify.entity.not_found", options: [] };
  const values = setup({ sendMessage: vi.fn().mockResolvedValue({ status: "NEEDS_CLARIFICATION", clarificationId: "clarification-account", clarifications: [clarification] }) });
  await values.flow.submitMessage("Send NTU USD 7000 using my SGD account"); await values.flow.answerClarificationText(clarification, "DBS Multiplier Account");
  expect(values.api.answerClarification).toHaveBeenCalledWith("clarification-account", { answerText: "DBS Multiplier Account" });
  expect(JSON.stringify(vi.mocked(values.api.answerClarification).mock.calls)).not.toMatch(/entityId|entityBinding|confirmed|goalContractHash|planHash/u);
});

it("cancels clarification without confirmation, compilation, approval, or execution", async () => {
  const clarification = { reason: "ENTITY_NOT_FOUND", field: "recipientReference", originalReference: "John", questionKey: "clarify.entity.not_found", options: [] };
  const values = setup({ sendMessage: vi.fn().mockResolvedValue({ status: "NEEDS_CLARIFICATION", clarificationId: "clarification-cancel", clarifications: [clarification] }) });
  await values.flow.submitMessage("Send John $500"); values.flow.reset();
  expect(values.flow.state.phase).toBe("COMPOSE"); expect(values.api.answerClarification).not.toHaveBeenCalled(); expect(values.api.confirmGoal).not.toHaveBeenCalled(); expect(values.api.compileGoal).not.toHaveBeenCalled(); expect(values.api.approvalOptions).not.toHaveBeenCalled(); expect(values.api.runExecution).not.toHaveBeenCalled();
});

it("does not confirm, compile, authorize, or execute when candidate data arrives without a customer action", async () => {
  const values = setup(); await values.flow.submitMessage("Send USD 7000.00 to NTU");
  expect(values.flow.state).toMatchObject({ phase: "GOAL_REVIEW", candidateId: "candidate-1" });
  expect(values.api.confirmGoal).not.toHaveBeenCalled(); expect(values.api.compileGoal).not.toHaveBeenCalled();
  expect(values.api.approvalOptions).not.toHaveBeenCalled(); expect(values.api.verifyApproval).not.toHaveBeenCalled(); expect(values.api.runExecution).not.toHaveBeenCalled();
});

it("stops safely when semantic validation rejects the candidate", async () => {
  const values = setup({
    sendMessage: vi.fn().mockResolvedValue({
      status: "SEMANTIC_VALIDATION_FAILED",
      message: "We couldn't safely verify that we understood your request. Please clarify or rephrase it.",
    }),
  });
  await values.flow.submitMessage("Send USD 7,000 to NTU");
  expect(values.flow.state).toEqual({
    phase: "SEMANTIC_VALIDATION_FAILED",
    requestText: "Send USD 7,000 to NTU",
    message: "We couldn't safely verify that we understood your request. Please clarify or rephrase it.",
  });
  expect(values.api.confirmGoal).not.toHaveBeenCalled();
  expect(values.api.compileGoal).not.toHaveBeenCalled();
  expect(values.api.approvalOptions).not.toHaveBeenCalled();
  expect(values.api.verifyApproval).not.toHaveBeenCalled();
  expect(values.api.runExecution).not.toHaveBeenCalled();
});

it("confirms exactly once and starts compilation only after explicit confirmation succeeds", async () => {
  let resolveConfirmation!: (value: GoalContractV1) => void;
  const confirmation = new Promise<GoalContractV1>((resolve) => { resolveConfirmation = resolve; });
  const values = setup({ confirmGoal: vi.fn().mockReturnValue(confirmation) });
  await values.flow.submitMessage("Send USD 7000.00 to NTU");
  const confirming = values.flow.confirmMeaning();
  expect(values.flow.state.phase).toBe("CONFIRMING_GOAL"); expect(values.api.confirmGoal).toHaveBeenCalledOnce(); expect(values.api.compileGoal).not.toHaveBeenCalled();
  resolveConfirmation(goal); await confirming;
  expect(values.api.confirmGoal).toHaveBeenCalledWith("candidate-1"); expect(values.api.compileGoal).toHaveBeenCalledOnce(); expect(values.api.compileGoal).toHaveBeenCalledWith(goal.id); expect(values.flow.state.phase).toBe("PLAN_REVIEW");
});

it("uses one explicit meaning confirmation and one compilation for a combined request", async () => {
  const values = setup({
    sendMessage: vi.fn().mockResolvedValue({ status: "AWAITING_BUNDLE_CONFIRMATION", candidateId: "bundle-candidate", goalBundleCandidate: bundleCandidate }),
    confirmGoalBundle: vi.fn().mockResolvedValue(bundle),
    compileGoalBundle: vi.fn().mockResolvedValue({ financialPlan: bundlePlan, satisfactionProof: { schemaVersion: "1", bundleId: bundle.bundleId, bundleContractHash: bundle.contractHash, itemCoverage: [{ itemId: "item-1", satisfiedByStepIds: ["transfer-1"] }, { itemId: "item-2", satisfiedByStepIds: ["fx-1"] }], allItemsSatisfied: true, allHardConstraintsSatisfied: true, allExplicitDependenciesSatisfied: true, allIrreversibleStepsJustified: true } }),
  });
  await values.flow.submitMessage("Send John USD 300 and buy one Apple share.");
  expect(values.flow.state).toMatchObject({ phase: "BUNDLE_REVIEW", candidateId: "bundle-candidate" });
  expect(values.api.confirmGoalBundle).not.toHaveBeenCalled(); expect(values.api.compileGoalBundle).not.toHaveBeenCalled();
  await values.flow.confirmMeaning();
  expect(values.api.confirmGoalBundle).toHaveBeenCalledOnce(); expect(values.api.confirmGoalBundle).toHaveBeenCalledWith("bundle-candidate");
  expect(values.api.compileGoalBundle).toHaveBeenCalledOnce(); expect(values.api.compileGoalBundle).toHaveBeenCalledWith(bundle.bundleId);
  expect(values.api.confirmGoal).not.toHaveBeenCalled(); expect(values.flow.state).toMatchObject({ phase: "PLAN_REVIEW", bundle: { bundleId: bundle.bundleId }, plan: { id: bundlePlan.id } });
});

it("does not confirm after repeated state reads that model rerenders", async () => {
  const values = setup(); await values.flow.submitMessage("Send USD 7000.00 to NTU");
  expect(values.flow.state.phase).toBe("GOAL_REVIEW"); expect(values.flow.state.phase).toBe("GOAL_REVIEW");
  expect(values.api.confirmGoal).not.toHaveBeenCalled(); expect(values.api.compileGoal).not.toHaveBeenCalled();
});

it("does not recover or auto-confirm an unconfirmed candidate after controller reconstruction", async () => {
  const beforeRefresh = setup(); await beforeRefresh.flow.submitMessage("Send USD 7000.00 to NTU"); expect(beforeRefresh.flow.state.phase).toBe("GOAL_REVIEW");
  const afterRefresh = setup(); expect(afterRefresh.flow.state.phase).toBe("COMPOSE");
  expect(afterRefresh.api.confirmGoal).not.toHaveBeenCalled(); expect(afterRefresh.api.compileGoal).not.toHaveBeenCalled();
});

it("does not compile when confirmation fails and remains safely retryable", async () => {
  const values = setup({ confirmGoal: vi.fn().mockRejectedValueOnce(new Error("CONFIRMATION_FAILED")).mockResolvedValueOnce(goal) });
  await values.flow.submitMessage("Send USD 7000.00 to NTU"); await values.flow.confirmMeaning();
  expect(values.flow.state).toMatchObject({ phase: "GOAL_CONFIRMATION_FAILED", candidateId: "candidate-1", message: "CONFIRMATION_FAILED" }); expect(values.api.compileGoal).not.toHaveBeenCalled();
  await values.flow.confirmMeaning(); expect(values.api.confirmGoal).toHaveBeenCalledTimes(2); expect(values.api.compileGoal).toHaveBeenCalledOnce(); expect(values.flow.state.phase).toBe("PLAN_REVIEW");
});

it("coalesces duplicate confirmation events into one confirmation and one compilation", async () => {
  let resolveConfirmation!: (value: GoalContractV1) => void;
  const confirmation = new Promise<GoalContractV1>((resolve) => { resolveConfirmation = resolve; });
  const values = setup({ confirmGoal: vi.fn().mockReturnValue(confirmation) }); await values.flow.submitMessage("Send USD 7000.00 to NTU");
  const first = values.flow.confirmMeaning(); const duplicate = values.flow.confirmMeaning();
  expect(values.api.confirmGoal).toHaveBeenCalledOnce(); expect(values.api.compileGoal).not.toHaveBeenCalled();
  resolveConfirmation(goal); await Promise.all([first, duplicate]);
  expect(values.api.confirmGoal).toHaveBeenCalledOnce(); expect(values.api.compileGoal).toHaveBeenCalledOnce();
});

it("never executes when passkey verification has not succeeded", async () => {
  const values = setup({}, new PasskeyCancelledError()); await reachPlan(values); await values.flow.authorizeAndExecute();
  expect(values.flow.state.phase).toBe("PASSKEY_CANCELLED"); expect(values.api.verifyApproval).not.toHaveBeenCalled(); expect(values.api.runExecution).not.toHaveBeenCalled();
});

it("handles approval verification failure without execution", async () => {
  const values = setup({ verifyApproval: vi.fn().mockRejectedValue(new Error("WEBAUTHN_APPROVAL_VERIFICATION_FAILED")) }); await reachPlan(values); await values.flow.authorizeAndExecute();
  expect(values.flow.state.phase).toBe("APPROVAL_FAILED"); expect(values.api.runExecution).not.toHaveBeenCalled();
});

it("returns to the same still-valid plan after first-transaction passkey enrollment, then authorizes only on a fresh customer action", async () => {
  const approvalOptions = vi.fn().mockRejectedValueOnce(new Error("PASSKEY_CREDENTIAL_NOT_FOUND")).mockResolvedValueOnce({ challengeId: "challenge-2", options: { challenge: "challenge-2" } });
  const values = setup({ approvalOptions }); await reachPlan(values); await values.flow.authorizeAndExecute();
  expect(values.flow.state).toMatchObject({ phase: "PASSKEY_REQUIRED", plan: { id: plan.id } }); expect(values.api.verifyApproval).not.toHaveBeenCalled(); expect(values.api.runExecution).not.toHaveBeenCalled();
  await values.flow.passkeyEnrolled(); expect(values.flow.state).toMatchObject({ phase: "PLAN_REVIEW", passkeyReady: true, plan: { id: plan.id } });
  expect(approvalOptions).toHaveBeenCalledOnce(); expect(values.api.runExecution).not.toHaveBeenCalled();
  await values.flow.authorizeAndExecute(); expect(values.flow.state.phase).toBe("COMPLETED"); expect(approvalOptions).toHaveBeenCalledTimes(2);
});

it("refreshes an expired plan after enrollment and requires review before any approval challenge", async () => {
  const expiredPlan = FinancialPlanV1.parse({ ...plan, validity: { ...plan.validity, validUntil: "2020-01-01T00:00:00.000Z" } });
  const compileGoal = vi.fn().mockResolvedValueOnce({ schemaVersion: "1", status: "SAT", plan: expiredPlan }).mockResolvedValueOnce({ schemaVersion: "1", status: "SAT", plan: refreshedPlan });
  const approvalOptions = vi.fn().mockRejectedValueOnce(new Error("PASSKEY_CREDENTIAL_NOT_FOUND"));
  const values = setup({ compileGoal, approvalOptions }); await reachPlan(values); await values.flow.authorizeAndExecute(); await values.flow.passkeyEnrolled();
  expect(values.flow.state).toMatchObject({ phase: "PLAN_REVIEW", refreshed: true, plan: { id: refreshedPlan.id } });
  expect(compileGoal).toHaveBeenCalledTimes(2); expect(approvalOptions).toHaveBeenCalledOnce(); expect(values.api.verifyApproval).not.toHaveBeenCalled(); expect(values.api.runExecution).not.toHaveBeenCalled();
});

it("recompiles an expired plan and requires review before requesting a new passkey", async () => {
  const compileGoal = vi.fn().mockResolvedValueOnce({ schemaVersion: "1", status: "SAT", plan }).mockResolvedValueOnce({ schemaVersion: "1", status: "SAT", plan: refreshedPlan });
  const approvalOptions = vi.fn().mockRejectedValueOnce(new Error("FINANCIAL_PLAN_EXPIRED"));
  const values = setup({ compileGoal, approvalOptions }); await reachPlan(values); await values.flow.authorizeAndExecute();
  expect(values.flow.state).toMatchObject({ phase: "PLAN_REVIEW", refreshed: true, plan: { id: refreshedPlan.id } });
  expect(compileGoal).toHaveBeenNthCalledWith(2, goal.id); expect(approvalOptions).toHaveBeenCalledOnce();
  expect(values.passkey.request).not.toHaveBeenCalled(); expect(values.api.verifyApproval).not.toHaveBeenCalled(); expect(values.api.runExecution).not.toHaveBeenCalled();
});

it("refreshes instead of authorizing when the plan expires during passkey verification", async () => {
  const compileGoal = vi.fn().mockResolvedValueOnce({ schemaVersion: "1", status: "SAT", plan }).mockResolvedValueOnce({ schemaVersion: "1", status: "SAT", plan: refreshedPlan });
  const values = setup({ compileGoal, verifyApproval: vi.fn().mockRejectedValueOnce(new Error("FINANCIAL_PLAN_EXPIRED")) }); await reachPlan(values); await values.flow.authorizeAndExecute();
  expect(values.passkey.request).toHaveBeenCalledOnce(); expect(values.flow.state).toMatchObject({ phase: "PLAN_REVIEW", refreshed: true, plan: { id: refreshedPlan.id } });
  expect(values.api.runExecution).not.toHaveBeenCalled();
});

it.each([[
  "PAUSED", "PAUSED",
], [
  "REAPPROVAL_REQUIRED", "REAPPROVAL_REQUIRED",
]] as const)("maps an UNKNOWN execution to %s from authoritative execution detail", async (backendState, phase) => {
  const values = setup({ runExecution: vi.fn().mockResolvedValue(unknown), executionDetail: vi.fn().mockResolvedValue({ state: backendState, result: unknown }) }); await reachPlan(values); await values.flow.authorizeAndExecute();
  expect(values.flow.state.phase).toBe(phase); expect(values.api.executionDetail).toHaveBeenCalledWith("execution-1");
});

it("surfaces an execution failure as a terminal customer state", async () => {
  const failed = ExecutionResultV1.parse({ ...unknown, status: "FAILED", goalOutcome: { achieved: false, summary: "Bank write failed." } });
  const values = setup({ runExecution: vi.fn().mockResolvedValue(failed) }); await reachPlan(values); await values.flow.authorizeAndExecute(); expect(values.flow.state.phase).toBe("EXECUTION_ERROR");
});

it("maps compiler policy refusal to the safe customer stop state", async () => {
  const values = setup({ compileGoal: vi.fn().mockResolvedValue({ schemaVersion: "1", status: "POLICY_BLOCKED", reason: { code: "SERVICE_UNAVAILABLE", message: "Required service is unavailable." } }) });
  await values.flow.submitMessage("Send NTU USD 5,000"); await values.flow.confirmMeaning();
  expect(values.flow.state).toMatchObject({ phase: "UNAVAILABLE", kind: "POLICY_BLOCKED" }); expect(values.api.approvalOptions).not.toHaveBeenCalled();
});
