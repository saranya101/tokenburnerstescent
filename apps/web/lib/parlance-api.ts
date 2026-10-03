import {
  BankStateSnapshotV1, CompileGoalBundleResultV1, CompilerResultV1, ExecutionResultV1, GoalBundleContractV1, GoalContractV1,
  type BankStateSnapshotV1 as BankStateSnapshot,
  type ExecutionResultV1 as ExecutionResult, type GoalBundleContractV1 as GoalBundleContract, type GoalContractV1 as GoalContract,
} from "@parlance/contracts";

export type GoalCandidate = Pick<GoalContract, "schemaVersion" | "goal" | "constraints" | "preferences" | "entityBindings">;
export type GoalBundleCandidate = Pick<GoalBundleContract, "schemaVersion" | "items" | "globalConstraints" | "explicitDependencies">;
export type ClarificationOption = { entityId: string; entityType: "ACCOUNT" | "BENEFICIARY" | "ASSET" | "BILLER" | "OBLIGATION"; displayName: string; currency?: string; availableMinorUnits?: string };
export type Clarification = { reason: string; field: string; originalReference: string; questionKey: string; options: ClarificationOption[] };
export type MessageResponse =
  | { status: "NEEDS_CLARIFICATION"; clarificationId: string; clarifications: Clarification[] }
  | { status: "NEEDS_BUNDLE_CLARIFICATION"; clarificationId: string; clarifications: Clarification[] }
  | { status: "AWAITING_GOAL_CONFIRMATION"; candidateId: string; goalCandidate: GoalCandidate }
  | { status: "AWAITING_BUNDLE_CONFIRMATION"; candidateId: string; goalBundleCandidate: GoalBundleCandidate }
  | { status: "SEMANTIC_VALIDATION_FAILED"; message: string };
export type MessageInputProvenance = { inputMode: "TYPED" } | { inputMode: "VOICE"; voice: { rawTranscript: string; provider: string; transcribedAt: string } };
export type AuthenticationOptionsJSON = {
  challenge: string; timeout?: number; rpId?: string; userVerification?: UserVerificationRequirement;
  allowCredentials?: Array<{ id: string; type: "public-key"; transports?: AuthenticatorTransport[] }>;
  extensions?: AuthenticationExtensionsClientInputs;
};
export type AuthenticationCredentialJSON = {
  id: string; rawId: string; type: "public-key";
  response: { clientDataJSON: string; authenticatorData: string; signature: string; userHandle?: string };
  clientExtensionResults: AuthenticationExtensionsClientOutputs;
  authenticatorAttachment?: "cross-platform" | "platform";
};
export type RegistrationOptionsJSON = Omit<PublicKeyCredentialCreationOptions, "challenge" | "user" | "excludeCredentials"> & {
  challenge: string;
  user: Omit<PublicKeyCredentialUserEntity, "id"> & { id: string };
  excludeCredentials?: Array<Omit<PublicKeyCredentialDescriptor, "id"> & { id: string }>;
};
export type RegistrationCredentialJSON = {
  id: string; rawId: string; type: "public-key";
  response: { clientDataJSON: string; attestationObject: string; transports: AuthenticatorTransport[] };
  clientExtensionResults: AuthenticationExtensionsClientOutputs;
  authenticatorAttachment?: "cross-platform" | "platform";
};
export type PasskeyStatusResponse = { status: "NOT_ENROLLED" | "READY"; userVerification: "required" };
export type RegistrationOptionsResponse = { challengeId: string; options: RegistrationOptionsJSON };
export type ApprovalOptionsResponse = { challengeId: string; options: AuthenticationOptionsJSON };
export type ApprovalVerificationResponse = { execution: ExecutionResult };
export type ExecutionDetail = { state: "AUTHORIZED" | "EXECUTING" | "PAUSED" | "REAPPROVAL_REQUIRED" | "COMPLETED" | "FAILED"; result: ExecutionResult };

const GoalCandidateSchema = GoalContractV1.pick({ schemaVersion: true, goal: true, constraints: true, preferences: true, entityBindings: true });

function parseGoalBundleCandidate(value: unknown): GoalBundleCandidate {
  const item = record(value);
  const parsed = GoalBundleContractV1.parse({
    schemaVersion: item?.schemaVersion, items: item?.items, globalConstraints: item?.globalConstraints, explicitDependencies: item?.explicitDependencies,
    bundleId: "candidate-validation", bundleVersion: 1, contractHash: "0".repeat(64),
  });
  return { schemaVersion: parsed.schemaVersion, items: parsed.items, globalConstraints: parsed.globalConstraints, explicitDependencies: parsed.explicitDependencies };
}

export class ParlanceApiError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code); }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

async function responseJson(response: Response): Promise<unknown> {
  let value: unknown;
  try { value = await response.json(); } catch { throw new ParlanceApiError("INVALID_API_RESPONSE", response.status); }
  if (!response.ok) {
    const item = record(value); throw new ParlanceApiError(typeof item?.code === "string" ? item.code : "API_REQUEST_FAILED", response.status);
  }
  return value;
}

export function createParlanceApi(fetcher: typeof fetch = fetch) {
  const request = async (path: string, method: "GET" | "POST", body?: unknown): Promise<unknown> => responseJson(await fetcher(`/api/parlance/${path}`, {
    method, cache: "no-store", ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  }));
  return {
    async customerState(): Promise<BankStateSnapshot> {
      return BankStateSnapshotV1.parse(await request("customer/state", "GET"));
    },
    async sendMessage(text: string, input: MessageInputProvenance = { inputMode: "TYPED" }): Promise<MessageResponse> {
      const value = record(await request("messages", "POST", input.inputMode === "VOICE" ? { text, inputMode: "VOICE", voice: input.voice } : { text }));
      if (value?.status === "SEMANTIC_VALIDATION_FAILED" && typeof value.message === "string") return { status: value.status, message: value.message };
      if (value?.status === "NEEDS_CLARIFICATION" && typeof value.clarificationId === "string" && Array.isArray(value.clarifications)) return { status: value.status, clarificationId: value.clarificationId, clarifications: value.clarifications as Clarification[] };
      if (value?.status === "NEEDS_BUNDLE_CLARIFICATION" && typeof value.clarificationId === "string" && Array.isArray(value.clarifications)) return { status: value.status, clarificationId: value.clarificationId, clarifications: value.clarifications as Clarification[] };
      if (value?.status === "AWAITING_GOAL_CONFIRMATION" && typeof value.candidateId === "string") return { status: value.status, candidateId: value.candidateId, goalCandidate: GoalCandidateSchema.parse(value.goalCandidate) };
      if (value?.status === "AWAITING_BUNDLE_CONFIRMATION" && typeof value.candidateId === "string") return { status: value.status, candidateId: value.candidateId, goalBundleCandidate: parseGoalBundleCandidate(value.goalBundleCandidate) };
      throw new ParlanceApiError("INVALID_API_RESPONSE", 502);
    },
    async answerClarification(clarificationId: string, answer: { selectedCandidateId: string } | { answerText: string }): Promise<MessageResponse> {
      const value = record(await request(`clarifications/${encodeURIComponent(clarificationId)}/answer`, "POST", answer));
      if (value?.status === "SEMANTIC_VALIDATION_FAILED" && typeof value.message === "string") return { status: value.status, message: value.message };
      if (value?.status === "NEEDS_CLARIFICATION" && typeof value.clarificationId === "string" && Array.isArray(value.clarifications)) return { status: value.status, clarificationId: value.clarificationId, clarifications: value.clarifications as Clarification[] };
      if (value?.status === "AWAITING_GOAL_CONFIRMATION" && typeof value.candidateId === "string") return { status: value.status, candidateId: value.candidateId, goalCandidate: GoalCandidateSchema.parse(value.goalCandidate) };
      throw new ParlanceApiError("INVALID_API_RESPONSE", 502);
    },
    async answerBundleClarification(clarificationId: string, answer: { selectedCandidateId: string } | { answerText: string }): Promise<MessageResponse> {
      const value = record(await request(`bundle-clarifications/${encodeURIComponent(clarificationId)}/answer`, "POST", answer));
      if (value?.status === "SEMANTIC_VALIDATION_FAILED" && typeof value.message === "string") return { status: value.status, message: value.message };
      if (value?.status === "NEEDS_BUNDLE_CLARIFICATION" && typeof value.clarificationId === "string" && Array.isArray(value.clarifications)) return { status: value.status, clarificationId: value.clarificationId, clarifications: value.clarifications as Clarification[] };
      if (value?.status === "AWAITING_BUNDLE_CONFIRMATION" && typeof value.candidateId === "string") return { status: value.status, candidateId: value.candidateId, goalBundleCandidate: parseGoalBundleCandidate(value.goalBundleCandidate) };
      throw new ParlanceApiError("INVALID_API_RESPONSE", 502);
    },
    async confirmGoal(candidateId: string): Promise<GoalContract> {
      const value = record(await request(`goal-candidates/${encodeURIComponent(candidateId)}/confirm`, "POST", {}));
      return GoalContractV1.parse(value?.goalContract);
    },
    async confirmGoalBundle(candidateId: string): Promise<GoalBundleContract> {
      const value = record(await request(`goal-bundle-candidates/${encodeURIComponent(candidateId)}/confirm`, "POST", {}));
      return GoalBundleContractV1.parse(value?.goalBundleContract);
    },
    async compileGoal(goalId: string) {
      return CompilerResultV1.parse(await request(`goals/${encodeURIComponent(goalId)}/compile`, "POST"));
    },
    async compileGoalBundle(bundleId: string) {
      const value = await request(`goal-bundles/${encodeURIComponent(bundleId)}/compile`, "POST");
      const item = record(value);
      return item && typeof item.status === "string" ? CompilerResultV1.parse(value) : CompileGoalBundleResultV1.parse(value);
    },
    async passkeyStatus(): Promise<PasskeyStatusResponse> {
      const value = record(await request("webauthn/registration/status", "GET"));
      if ((value?.status !== "NOT_ENROLLED" && value?.status !== "READY") || value.userVerification !== "required") throw new ParlanceApiError("INVALID_API_RESPONSE", 502);
      return { status: value.status, userVerification: value.userVerification };
    },
    async registrationOptions(): Promise<RegistrationOptionsResponse> {
      const value = record(await request("webauthn/registration/options", "POST", {})); const options = record(value?.options);
      if (typeof value?.challengeId !== "string" || !options || typeof options.challenge !== "string" || !record(options.user)) throw new ParlanceApiError("INVALID_API_RESPONSE", 502);
      return { challengeId: value.challengeId, options: options as RegistrationOptionsJSON };
    },
    async verifyRegistration(challengeId: string, credential: RegistrationCredentialJSON): Promise<{ verified: true }> {
      const value = record(await request("webauthn/registration/verify", "POST", { challengeId, credential }));
      if (value?.verified !== true) throw new ParlanceApiError("INVALID_API_RESPONSE", 502);
      return { verified: true };
    },
    async approvalOptions(planId: string): Promise<ApprovalOptionsResponse> {
      const value = record(await request(`plans/${encodeURIComponent(planId)}/approval-options`, "POST", {}));
      const options = record(value?.options);
      if (typeof value?.challengeId !== "string" || !options || typeof options.challenge !== "string") throw new ParlanceApiError("INVALID_API_RESPONSE", 502);
      return { challengeId: value.challengeId, options: options as AuthenticationOptionsJSON };
    },
    async verifyApproval(planId: string, challengeId: string, credential: AuthenticationCredentialJSON): Promise<ApprovalVerificationResponse> {
      const value = record(await request(`plans/${encodeURIComponent(planId)}/approval-verify`, "POST", { challengeId, credential }));
      return { execution: ExecutionResultV1.parse(value?.execution) };
    },
    async runExecution(executionId: string): Promise<ExecutionResult> {
      return ExecutionResultV1.parse(await request(`executions/${encodeURIComponent(executionId)}/run`, "POST"));
    },
    async executionDetail(executionId: string): Promise<ExecutionDetail> {
      const value = record(await request(`executions/${encodeURIComponent(executionId)}/detail`, "GET"));
      if (!value || typeof value.state !== "string") throw new ParlanceApiError("INVALID_API_RESPONSE", 502);
      return { state: value.state as ExecutionDetail["state"], result: ExecutionResultV1.parse(value.result) };
    },
  };
}

export type ParlanceApi = ReturnType<typeof createParlanceApi>;
