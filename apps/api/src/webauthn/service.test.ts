import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AuthenticationResponseJSON, RegistrationResponseJSON, VerifiedAuthenticationResponse, VerifiedRegistrationResponse } from "@simplewebauthn/server";
import { BankStateSnapshotV1, ExecutionResultV1, FinancialPlanV1, GoalContractV1 } from "@parlance/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp, type ApiServices } from "../app.js";
import type { BankPort, ParlanceRepository, StoredGoal, StoredPlan } from "../orchestration/ports.js";
import { hashFinancialPlan, hashGoalContract } from "../security/canonical-hash.js";
import { WebAuthnService } from "./service.js";
import type { AuthenticationVerifier, NewWebAuthnChallenge, NewWebAuthnCredential, RegistrationVerifier, StoredApprovalEvidence, StoredWebAuthnChallenge, StoredWebAuthnCredential, VerifiedPasskeyAuthorizationInput, WebAuthnRepository } from "./types.js";

const fixture = (name: string): unknown => JSON.parse(readFileSync(join(process.cwd(), "../../packages/contracts/fixtures/01-ntu-transfer", name), "utf8"));
const fixedNow = new Date("2026-09-23T10:00:00.000Z");

function authoritativeRecords(): { goal: StoredGoal; plan: StoredPlan; state: BankStateSnapshotV1 } {
  const rawGoal = GoalContractV1.parse({ ...(fixture("goal-contract.json") as object), userId: "demo-user", contractHash: "0".repeat(64) });
  const goalContract = GoalContractV1.parse({ ...rawGoal, contractHash: hashGoalContract(rawGoal) });
  const rawPlan = FinancialPlanV1.parse({ ...(fixture("financial-plan.json") as object), goalContractId: goalContract.id, goalContractVersion: goalContract.version, bankStateVersion: 7, planHash: "0".repeat(64) });
  const financialPlan = FinancialPlanV1.parse({ ...rawPlan, planHash: hashFinancialPlan(rawPlan) });
  const state = BankStateSnapshotV1.parse({ ...(fixture("bank-state.json") as object), userId: "demo-user", stateVersion: 7 });
  return { goal: { rowId: "goal-row", contract: goalContract }, plan: { goalRowId: "goal-row", plan: financialPlan }, state };
}

class MemoryRepository {
  readonly users = new Set(["demo-user"]);
  readonly challenges = new Map<string, StoredWebAuthnChallenge>();
  readonly credentials = new Map<string, StoredWebAuthnCredential>();
  readonly evidences = new Map<string, StoredApprovalEvidence>();
  snapshots = 0; approvals = 0; executions = 0;
  approvalRecord?: VerifiedPasskeyAuthorizationInput["approval"];
  executionResult?: ExecutionResultV1;
  constructor(readonly goal: StoredGoal, readonly plan: StoredPlan) {}
  async getConfirmedGoal(id: string) { return id === this.goal.contract.id ? this.goal : null; }
  async getPlan(id: string) { return id === this.plan.plan.id ? this.plan : null; }
  async saveSnapshot() { this.snapshots += 1; }
  async webAuthnUserExists(id: string) { return this.users.has(id); }
  async createWebAuthnChallenge(input: NewWebAuthnChallenge) {
    const row: StoredWebAuthnChallenge = { ...input, userHandle: input.userHandle ?? null, status: "ISSUED", financialPlanId: input.financialPlanId ?? null, approvalPayload: input.approvalPayload ?? null, approvalPayloadHash: input.approvalPayloadHash ?? null, consumedAt: null, revokedAt: null, createdAt: fixedNow };
    this.challenges.set(row.id, row); return row;
  }
  async getWebAuthnChallenge(id: string) { return this.challenges.get(id) ?? null; }
  async expireWebAuthnChallenge(id: string, now: Date) { const row = this.challenges.get(id); if (!row || row.status !== "ISSUED" || row.expiresAt > now) return false; row.status = "EXPIRED"; return true; }
  async revokeWebAuthnChallenge(id: string, now: Date) { const row = this.challenges.get(id); if (!row || row.status !== "ISSUED") return false; row.status = "REVOKED"; row.revokedAt = now; return true; }
  async consumeRegistrationChallenge(input: { challengeId: string; userId: string; now: Date; credential: NewWebAuthnCredential }) {
    const row = this.challenges.get(input.challengeId);
    if (!row || row.userId !== input.userId || row.purpose !== "REGISTRATION" || row.status !== "ISSUED" || row.revokedAt || row.expiresAt <= input.now) return false;
    row.status = "CONSUMED"; row.consumedAt = input.now;
    await this.saveWebAuthnCredential(input.credential); return true;
  }
  async saveWebAuthnCredential(input: NewWebAuthnCredential) {
    if (this.credentials.has(input.credentialId)) throw new Error("duplicate credential");
    const row: StoredWebAuthnCredential = { ...input, createdAt: fixedNow, lastUsedAt: null, revokedAt: null };
    this.credentials.set(row.credentialId, row); return row;
  }
  async getWebAuthnCredential(id: string) { return this.credentials.get(id) ?? null; }
  async listActiveWebAuthnCredentials(userId: string) { return [...this.credentials.values()].filter((item) => item.userId === userId && !item.revokedAt); }
  async revokeWebAuthnCredential(id: string, userId: string, now: Date) { const row = this.credentials.get(id); if (!row || row.userId !== userId || row.revokedAt) return false; row.revokedAt = now; return true; }
  async authorizeVerifiedPasskey(input: VerifiedPasskeyAuthorizationInput) {
    const challenge = this.challenges.get(input.challengeId); const credential = [...this.credentials.values()].find((item) => item.id === input.credentialId);
    if (!challenge || challenge.status !== "ISSUED" || challenge.revokedAt || challenge.expiresAt <= input.now || challenge.financialPlanId !== input.approval.financialPlanId) throw new Error("WEBAUTHN_APPROVAL_CHALLENGE_ALREADY_USED");
    if (!credential || credential.revokedAt || credential.signCount !== input.expectedCounter) throw new Error("WEBAUTHN_CREDENTIAL_STATE_CHANGED");
    challenge.status = "CONSUMED"; challenge.consumedAt = input.now; credential.signCount = input.newCounter; credential.lastUsedAt = input.now;
    this.evidences.set(input.evidence.id, input.evidence); this.approvalRecord = input.approval; this.approvals += 1; this.executions += 1;
    this.executionResult = ExecutionResultV1.parse({ schemaVersion: "1", executionId: input.executionId, planId: input.approval.financialPlanId, status: "PENDING", startedStateVersion: input.approval.bankStateVersion, steps: [], goalOutcome: { achieved: false, summary: "Execution has not completed." } });
    return { evidence: input.evidence, execution: this.executionResult };
  }
}

class ControlledBank implements BankPort {
  reads = 0; writes = 0;
  constructor(public state: BankStateSnapshotV1) {}
  async getState() { this.reads += 1; return this.state; }
  async execute() { this.writes += 1; return { accepted: true as const, bankReference: "unexpected", stateVersion: 8 }; }
}

class TestAuthenticationVerifier implements AuthenticationVerifier {
  calls: Parameters<AuthenticationVerifier["verify"]>[0][] = [];
  async verify(input: Parameters<AuthenticationVerifier["verify"]>[0]): Promise<VerifiedAuthenticationResponse> {
    this.calls.push(input); const marker = input.response.response.signature;
    if (input.response.response.clientDataJSON !== input.expectedChallenge || marker === "reject") throw new Error("invalid assertion");
    return { verified: true, authenticationInfo: {
      credentialID: input.response.id, newCounter: input.credential.counter + 1, userVerified: marker !== "uv-false",
      credentialDeviceType: "multiDevice", credentialBackedUp: true,
      origin: marker === "wrong-origin" ? "https://attacker.example" : input.expectedOrigin,
      rpID: marker === "wrong-rp" ? "attacker.example" : input.expectedRpId,
    } };
  }
}

class TestVerifier implements RegistrationVerifier {
  calls: Parameters<RegistrationVerifier["verify"]>[0][] = [];
  async verify(input: Parameters<RegistrationVerifier["verify"]>[0]): Promise<VerifiedRegistrationResponse> {
    this.calls.push(input);
    if (input.response.response.clientDataJSON !== input.expectedChallenge || input.response.id === "reject") throw new Error("invalid signed ceremony");
    return { verified: true, registrationInfo: {
      fmt: "none", aaguid: "00000000-0000-0000-0000-000000000000",
      credential: { id: "credential-1", publicKey: new Uint8Array([1, 2, 3]), counter: 0, transports: ["internal"] },
      credentialType: "public-key", attestationObject: new Uint8Array(), userVerified: true,
      credentialDeviceType: "multiDevice", credentialBackedUp: true,
      origin: input.expectedOrigin, rpID: input.expectedRpId,
    } };
  }
}

const response = (challenge: string, id = "browser-credential"): RegistrationResponseJSON => ({ id, rawId: id, type: "public-key", clientExtensionResults: {}, response: { clientDataJSON: challenge, attestationObject: "attestation", transports: ["internal"] } });
const assertion = (challenge: string, id = "credential-1", signature = "valid"): AuthenticationResponseJSON => ({ id, rawId: id, type: "public-key", clientExtensionResults: {}, response: { clientDataJSON: challenge, authenticatorData: "authenticator-data", signature } });

function setup() {
  const records = authoritativeRecords(); const repository = new MemoryRepository(records.goal, records.plan); const bank = new ControlledBank(records.state); const verifier = new TestVerifier(); const authenticationVerifier = new TestAuthenticationVerifier();
  const service = new WebAuthnService(repository as unknown as ParlanceRepository & WebAuthnRepository, bank, verifier, authenticationVerifier, () => new Date(fixedNow));
  return { ...records, repository, bank, verifier, authenticationVerifier, service };
}

async function approvalCeremony(values: ReturnType<typeof setup>) {
  await values.repository.saveWebAuthnCredential({ id: "credential-row", userId: values.goal.contract.userId, credentialId: "credential-1", publicKey: new Uint8Array([1, 2, 3]), userHandle: new Uint8Array([2]), signCount: 0, transports: ["internal"], deviceType: "multiDevice", backedUp: true });
  const issued = await values.service.approvalOptions(values.plan.plan.id, "trace-approval");
  return { issued, challenge: values.repository.challenges.get(issued.challengeId)! };
}

beforeEach(() => {
  vi.stubEnv("PARLANCE_WEBAUTHN_RP_ID", "localhost"); vi.stubEnv("PARLANCE_WEBAUTHN_ORIGIN", "http://localhost:3000");
  vi.stubEnv("PARLANCE_DEMO_WEBAUTHN_ENROLLMENT", "true"); vi.stubEnv("PARLANCE_DEMO_USER_ID", "demo-user");
});
afterEach(() => vi.unstubAllEnvs());

describe("WebAuthn Phase 1 registration", () => {
  it("issues and persists a cryptographic registration challenge for the configured demo user and RP", async () => {
    const { service, repository } = setup(); const issued = await service.registrationOptions(); const stored = repository.challenges.get(issued.challengeId)!;
    expect(stored).toMatchObject({ userId: "demo-user", purpose: "REGISTRATION", expectedRpId: "localhost", expectedOrigin: "http://localhost:3000", status: "ISSUED" });
    expect(stored.challenge).toBe(issued.options.challenge); expect(Buffer.from(stored.challenge, "base64url")).toHaveLength(32);
    expect(issued.options.rp.id).toBe("localhost"); expect(issued.options.authenticatorSelection?.userVerification).toBe("required");
  });

  it("verifies the expected ceremony, consumes once, and persists a credential for the bound user", async () => {
    const { service, repository, verifier } = setup(); const issued = await service.registrationOptions(); const challenge = repository.challenges.get(issued.challengeId)!;
    await expect(service.verifyRegistration(issued.challengeId, response(challenge.challenge))).resolves.toEqual({ credentialId: "credential-1", userId: "demo-user", verified: true });
    expect(verifier.calls[0]).toMatchObject({ expectedChallenge: challenge.challenge, expectedOrigin: "http://localhost:3000", expectedRpId: "localhost" });
    expect(repository.credentials.get("credential-1")).toMatchObject({ userId: "demo-user", signCount: 0, backedUp: true });
    expect(repository.challenges.get(issued.challengeId)?.status).toBe("CONSUMED");
  });

  it("rejects expired, revoked, replayed, and incorrectly signed challenges", async () => {
    const expired = setup(); const expiredIssue = await expired.service.registrationOptions(); expired.repository.challenges.get(expiredIssue.challengeId)!.expiresAt = new Date(fixedNow.getTime() - 1);
    await expect(expired.service.verifyRegistration(expiredIssue.challengeId, response("anything"))).rejects.toThrow("WEBAUTHN_REGISTRATION_CHALLENGE_EXPIRED");
    expect(expired.repository.credentials.size).toBe(0);

    const revoked = setup(); const revokedIssue = await revoked.service.registrationOptions(); const revokedChallenge = revoked.repository.challenges.get(revokedIssue.challengeId)!; await revoked.repository.revokeWebAuthnChallenge(revokedIssue.challengeId, fixedNow);
    await expect(revoked.service.verifyRegistration(revokedIssue.challengeId, response(revokedChallenge.challenge))).rejects.toThrow("WEBAUTHN_REGISTRATION_CHALLENGE_INVALID");

    const wrong = setup(); const wrongIssue = await wrong.service.registrationOptions(); await expect(wrong.service.verifyRegistration(wrongIssue.challengeId, response("wrong-challenge"))).rejects.toThrow("WEBAUTHN_REGISTRATION_VERIFICATION_FAILED");

    const replay = setup(); const replayIssue = await replay.service.registrationOptions(); const replayChallenge = replay.repository.challenges.get(replayIssue.challengeId)!; await replay.service.verifyRegistration(replayIssue.challengeId, response(replayChallenge.challenge));
    await expect(replay.service.verifyRegistration(replayIssue.challengeId, response(replayChallenge.challenge))).rejects.toThrow("WEBAUTHN_REGISTRATION_CHALLENGE_INVALID");
  });

  it("rejects origin or RP configuration drift before verification", async () => {
    const origin = setup(); const originIssue = await origin.service.registrationOptions(); const originChallenge = origin.repository.challenges.get(originIssue.challengeId)!; vi.stubEnv("PARLANCE_WEBAUTHN_ORIGIN", "http://localhost:3001");
    await expect(origin.service.verifyRegistration(originIssue.challengeId, response(originChallenge.challenge))).rejects.toThrow("WEBAUTHN_REGISTRATION_CHALLENGE_INVALID");
    vi.stubEnv("PARLANCE_WEBAUTHN_ORIGIN", "http://localhost:3000"); const rp = setup(); const rpIssue = await rp.service.registrationOptions(); const rpChallenge = rp.repository.challenges.get(rpIssue.challengeId)!; vi.stubEnv("PARLANCE_WEBAUTHN_RP_ID", "example.com"); vi.stubEnv("PARLANCE_WEBAUTHN_ORIGIN", "https://example.com");
    await expect(rp.service.verifyRegistration(rpIssue.challengeId, response(rpChallenge.challenge))).rejects.toThrow("WEBAUTHN_REGISTRATION_CHALLENGE_INVALID");
  });

  it("allows exactly one concurrent challenge consumer", async () => {
    const { service, repository } = setup(); const issued = await service.registrationOptions(); const challenge = repository.challenges.get(issued.challengeId)!;
    const results = await Promise.allSettled([service.verifyRegistration(issued.challengeId, response(challenge.challenge)), service.verifyRegistration(issued.challengeId, response(challenge.challenge))]);
    expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(1); expect(results.filter((item) => item.status === "rejected")).toHaveLength(1); expect(repository.credentials.size).toBe(1);
  });

  it("fails closed unless demo enrollment is explicitly enabled and rejects caller-selected users", async () => {
    const disabled = setup(); vi.stubEnv("PARLANCE_DEMO_WEBAUTHN_ENROLLMENT", "false"); await expect(disabled.service.registrationOptions()).rejects.toThrow("DEMO_WEBAUTHN_ENROLLMENT_DISABLED");
    vi.stubEnv("PARLANCE_DEMO_WEBAUTHN_ENROLLMENT", "true"); const enabled = setup();
    const app = buildApp({ webauthn: enabled.service } as unknown as ApiServices); const result = await app.inject({ method: "POST", url: "/v1/webauthn/registration/options", payload: { userId: "attacker" } });
    expect(result.statusCode).toBe(400); expect(enabled.repository.challenges.size).toBe(0); await app.close();
  });
});

describe("WebAuthn Phase 1 approval options", () => {
  it("binds only authoritative goal, plan, state, and server expiry without creating approval, execution, or bank writes", async () => {
    const { service, repository, bank, goal, plan } = setup();
    await repository.saveWebAuthnCredential({ id: "credential-row", userId: goal.contract.userId, credentialId: "credential-1", publicKey: new Uint8Array([1]), userHandle: new Uint8Array([2]), signCount: 0, transports: ["internal"], deviceType: "multiDevice", backedUp: true });
    const result = await service.approvalOptions(plan.plan.id, "trace-approval-options"); const stored = repository.challenges.get(result.challengeId)!;
    expect(stored).toMatchObject({ purpose: "APPROVAL", userId: goal.contract.userId, financialPlanId: plan.plan.id, approvalPayloadHash: result.approvalPayloadHash, status: "ISSUED" });
    expect(stored.approvalPayload).toEqual(expect.objectContaining({ userId: goal.contract.userId, goalContractHash: goal.contract.contractHash, financialPlanHash: plan.plan.planHash, bankStateVersion: 7, approvalExpiresAt: result.approvalExpiresAt }));
    expect(stored.expiresAt.getTime() - fixedNow.getTime()).toBe(3 * 60_000); expect(Date.parse(result.approvalExpiresAt) - fixedNow.getTime()).toBe(10 * 60_000);
    expect(result.options).toMatchObject({ rpId: "localhost", userVerification: "required" }); expect(bank).toMatchObject({ reads: 1, writes: 0 }); expect(repository).toMatchObject({ snapshots: 1, approvals: 0, executions: 0 });
  });

  it("rejects caller-supplied financial authority fields before reading bank state", async () => {
    const values = setup(); const app = buildApp({ webauthn: values.service } as unknown as ApiServices);
    const result = await app.inject({ method: "POST", url: `/v1/plans/${values.plan.plan.id}/approval-options`, payload: { userId: "attacker", bankStateVersion: 999 } });
    expect(result.statusCode).toBe(400); expect(values.bank).toMatchObject({ reads: 0, writes: 0 }); expect(values.repository.challenges.size).toBe(0); await app.close();
  });
});

describe("WebAuthn Phase 2A approval verification", () => {
  it("creates immutable evidence, PASSKEY approval, and AUTHORIZED execution from a verified assertion", async () => {
    const values = setup(); const { issued, challenge } = await approvalCeremony(values);
    const result = await values.service.verifyApproval(values.plan.plan.id, issued.challengeId, assertion(challenge.challenge), "trace-verify");
    expect(result.approval).toMatchObject({ method: "PASSKEY", signatureReference: result.evidence.id, userId: values.goal.contract.userId, financialPlanId: values.plan.plan.id });
    expect(result.evidence).toMatchObject({ approvalId: result.approval.id, userVerified: true, authenticatorCounterBefore: 0, authenticatorCounterAfter: 1, approvalPayloadHash: issued.approvalPayloadHash });
    expect(result.execution).toMatchObject({ status: "PENDING", planId: values.plan.plan.id });
    expect(values.repository).toMatchObject({ approvals: 1, executions: 1 }); expect(values.repository.credentials.get("credential-1")).toMatchObject({ signCount: 1, lastUsedAt: fixedNow });
    expect(values.authenticationVerifier.calls[0]).toMatchObject({ expectedChallenge: challenge.challenge, expectedOrigin: "http://localhost:3000", expectedRpId: "localhost", credential: { id: "credential-1", counter: 0 } });
  });

  it("rejects missing user verification without approval or execution", async () => {
    const values = setup(); const { issued, challenge } = await approvalCeremony(values);
    await expect(values.service.verifyApproval(values.plan.plan.id, issued.challengeId, assertion(challenge.challenge, "credential-1", "uv-false"), "trace")).rejects.toThrow("WEBAUTHN_APPROVAL_VERIFICATION_FAILED");
    expect(values.repository).toMatchObject({ approvals: 0, executions: 0 });
  });

  it.each([
    ["wrong origin", "wrong-origin"], ["wrong RP ID", "wrong-rp"], ["failed signature", "reject"],
  ])("rejects %s", async (_label, marker) => {
    const values = setup(); const { issued, challenge } = await approvalCeremony(values);
    await expect(values.service.verifyApproval(values.plan.plan.id, issued.challengeId, assertion(challenge.challenge, "credential-1", marker), "trace")).rejects.toThrow("WEBAUTHN_APPROVAL_VERIFICATION_FAILED");
    expect(values.repository.approvals).toBe(0);
  });

  it("rejects a wrong signed challenge", async () => {
    const values = setup(); const { issued } = await approvalCeremony(values);
    await expect(values.service.verifyApproval(values.plan.plan.id, issued.challengeId, assertion("wrong-challenge"), "trace")).rejects.toThrow("WEBAUTHN_APPROVAL_VERIFICATION_FAILED");
  });

  it("rejects unknown, revoked, and cross-user credentials", async () => {
    const unknown = setup(); const unknownIssue = await approvalCeremony(unknown); await expect(unknown.service.verifyApproval(unknown.plan.plan.id, unknownIssue.issued.challengeId, assertion(unknownIssue.challenge.challenge, "unknown"), "trace")).rejects.toThrow("PASSKEY_CREDENTIAL_NOT_FOUND");
    const revoked = setup(); const revokedIssue = await approvalCeremony(revoked); revoked.repository.credentials.get("credential-1")!.revokedAt = fixedNow; await expect(revoked.service.verifyApproval(revoked.plan.plan.id, revokedIssue.issued.challengeId, assertion(revokedIssue.challenge.challenge), "trace")).rejects.toThrow("PASSKEY_CREDENTIAL_INVALID");
    const other = setup(); const otherIssue = await approvalCeremony(other); other.repository.credentials.get("credential-1")!.userId = "other-user"; await expect(other.service.verifyApproval(other.plan.plan.id, otherIssue.issued.challengeId, assertion(otherIssue.challenge.challenge), "trace")).rejects.toThrow("PASSKEY_CREDENTIAL_INVALID");
  });

  it("rejects expired, revoked, and consumed approval challenges", async () => {
    const expired = setup(); const expiredIssue = await approvalCeremony(expired); expiredIssue.challenge.expiresAt = new Date(fixedNow.getTime() - 1); await expect(expired.service.verifyApproval(expired.plan.plan.id, expiredIssue.issued.challengeId, assertion(expiredIssue.challenge.challenge), "trace")).rejects.toThrow("WEBAUTHN_APPROVAL_CHALLENGE_EXPIRED");
    const revoked = setup(); const revokedIssue = await approvalCeremony(revoked); revokedIssue.challenge.status = "REVOKED"; revokedIssue.challenge.revokedAt = fixedNow; await expect(revoked.service.verifyApproval(revoked.plan.plan.id, revokedIssue.issued.challengeId, assertion(revokedIssue.challenge.challenge), "trace")).rejects.toThrow("WEBAUTHN_APPROVAL_CHALLENGE_INVALID");
    const consumed = setup(); const consumedIssue = await approvalCeremony(consumed); await consumed.service.verifyApproval(consumed.plan.plan.id, consumedIssue.issued.challengeId, assertion(consumedIssue.challenge.challenge), "trace"); await expect(consumed.service.verifyApproval(consumed.plan.plan.id, consumedIssue.issued.challengeId, assertion(consumedIssue.challenge.challenge), "trace")).rejects.toThrow("WEBAUTHN_APPROVAL_CHALLENGE_INVALID");
  });

  it("rejects an expired server-stored approval payload", async () => {
    const values = setup(); const { issued, challenge } = await approvalCeremony(values); const payload = { ...challenge.approvalPayload!, approvalExpiresAt: new Date(fixedNow.getTime() - 1).toISOString() };
    challenge.approvalPayload = payload; challenge.approvalPayloadHash = "server-recomputed-expired-payload-hash";
    await expect(values.service.verifyApproval(values.plan.plan.id, issued.challengeId, assertion(challenge.challenge), "trace")).rejects.toThrow("APPROVAL_PAYLOAD_EXPIRED");
  });

  it("rejects plan and goal mutations after challenge issuance", async () => {
    const plan = setup(); const planIssue = await approvalCeremony(plan); plan.plan.plan = FinancialPlanV1.parse({ ...plan.plan.plan, steps: [{ ...plan.plan.plan.steps[0]!, reversible: !plan.plan.plan.steps[0]!.reversible }, ...plan.plan.plan.steps.slice(1)] }); await expect(plan.service.verifyApproval(plan.plan.plan.id, planIssue.issued.challengeId, assertion(planIssue.challenge.challenge), "trace")).rejects.toThrow("APPROVAL_PLAN_BINDING_INVALID");
    const goal = setup(); const goalIssue = await approvalCeremony(goal); goal.goal.contract = GoalContractV1.parse({ ...goal.goal.contract, goal: { ...goal.goal.contract.goal, amount: { currency: "USD", minorUnits: "500001" } } }); await expect(goal.service.verifyApproval(goal.plan.plan.id, goalIssue.issued.challengeId, assertion(goalIssue.challenge.challenge), "trace")).rejects.toThrow("APPROVAL_GOAL_BINDING_INVALID");
  });

  it("rejects bank-state drift and a route/challenge plan mismatch", async () => {
    const drift = setup(); const driftIssue = await approvalCeremony(drift); drift.bank.state = BankStateSnapshotV1.parse({ ...drift.bank.state, stateVersion: 8 }); await expect(drift.service.verifyApproval(drift.plan.plan.id, driftIssue.issued.challengeId, assertion(driftIssue.challenge.challenge), "trace")).rejects.toThrow("APPROVAL_STATE_CHANGED"); expect(drift.repository.approvals).toBe(0);
    const mismatch = setup(); const mismatchIssue = await approvalCeremony(mismatch); await expect(mismatch.service.verifyApproval("other-plan", mismatchIssue.issued.challengeId, assertion(mismatchIssue.challenge.challenge), "trace")).rejects.toThrow("WEBAUTHN_APPROVAL_PLAN_MISMATCH");
  });

  it("allows exactly one concurrent assertion consumer", async () => {
    const values = setup(); const { issued, challenge } = await approvalCeremony(values);
    const outcomes = await Promise.allSettled([values.service.verifyApproval(values.plan.plan.id, issued.challengeId, assertion(challenge.challenge), "trace-1"), values.service.verifyApproval(values.plan.plan.id, issued.challengeId, assertion(challenge.challenge), "trace-2")]);
    expect(outcomes.filter((item) => item.status === "fulfilled")).toHaveLength(1); expect(outcomes.filter((item) => item.status === "rejected")).toHaveLength(1);
    expect(values.repository).toMatchObject({ approvals: 1, executions: 1 }); expect(values.repository.evidences.size).toBe(1);
  });

  it("strictly rejects caller financial bindings and leaves the old direct approval path disabled", async () => {
    const values = setup(); const { issued, challenge } = await approvalCeremony(values); const app = buildApp({ webauthn: values.service } as unknown as ApiServices);
    const tampered = await app.inject({ method: "POST", url: `/v1/plans/${values.plan.plan.id}/approval-verify`, payload: { challengeId: issued.challengeId, credential: assertion(challenge.challenge), userId: "attacker", financialPlanHash: "caller", expiresAt: "2099-01-01T00:00:00Z" } });
    expect(tampered.statusCode).toBe(400); expect(values.repository.approvals).toBe(0);
    const bypass = await app.inject({ method: "POST", url: `/v1/plans/${values.plan.plan.id}/approve`, payload: { userId: "demo-user", method: "PASSKEY", signatureReference: "caller" } });
    expect(bypass.statusCode).toBe(404); expect(values.repository.approvals).toBe(0); await app.close();
  });
});
