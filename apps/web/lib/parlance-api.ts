import {
  CompilerResultV1, ExecutionResultV1, GoalContractV1,
  type ExecutionResultV1 as ExecutionResult, type GoalContractV1 as GoalContract,
} from "@parlance/contracts";

export type GoalCandidate = Pick<GoalContract, "schemaVersion" | "goal" | "constraints" | "preferences" | "entityBindings">;
export type ClarificationOption = { entityId: string; entityType: "ACCOUNT" | "BENEFICIARY" | "ASSET" | "BILLER" | "OBLIGATION"; displayName: string };
export type Clarification = { reason: string; field: string; originalReference: string; questionKey: string; options: ClarificationOption[] };
export type MessageResponse =
  | { status: "NEEDS_CLARIFICATION"; clarifications: Clarification[] }
  | { status: "AWAITING_GOAL_CONFIRMATION"; candidateId: string; goalCandidate: GoalCandidate };
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
    async sendMessage(text: string): Promise<MessageResponse> {
      const value = record(await request("messages", "POST", { text }));
      if (value?.status === "NEEDS_CLARIFICATION" && Array.isArray(value.clarifications)) return { status: value.status, clarifications: value.clarifications as Clarification[] };
      if (value?.status === "AWAITING_GOAL_CONFIRMATION" && typeof value.candidateId === "string") return { status: value.status, candidateId: value.candidateId, goalCandidate: GoalCandidateSchema.parse(value.goalCandidate) };
      throw new ParlanceApiError("INVALID_API_RESPONSE", 502);
    },
    async confirmGoal(candidateId: string): Promise<GoalContract> {
      const value = record(await request(`goal-candidates/${encodeURIComponent(candidateId)}/confirm`, "POST", {}));
      return GoalContractV1.parse(value?.goalContract);
    },
    async compileGoal(goalId: string) {
      return CompilerResultV1.parse(await request(`goals/${encodeURIComponent(goalId)}/compile`, "POST"));
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
