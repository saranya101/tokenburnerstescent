import { randomBytes, randomUUID } from "node:crypto";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyRegistrationResponse,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import type { BankPort, ParlanceRepository } from "../orchestration/ports.js";
import { hashFinancialPlan, hashGoalContract } from "../security/canonical-hash.js";
import { buildApprovalPayload } from "./approval-payload.js";
import type { RegistrationVerifier, WebAuthnRepository } from "./types.js";

const CHALLENGE_TTL_MS = 3 * 60_000;
const APPROVAL_TTL_MS = 10 * 60_000;

function randomChallenge(): Uint8Array<ArrayBuffer> {
  return new Uint8Array(randomBytes(32));
}

function webAuthnConfig(): { rpId: string; origin: string } {
  const rpId = process.env.PARLANCE_WEBAUTHN_RP_ID?.trim();
  const origin = process.env.PARLANCE_WEBAUTHN_ORIGIN?.trim();
  if (!rpId || !origin) throw new Error("WEBAUTHN_CONFIGURATION_MISSING");
  let parsed: URL;
  try { parsed = new URL(origin); } catch { throw new Error("WEBAUTHN_CONFIGURATION_INVALID"); }
  if (parsed.origin !== origin || (parsed.hostname !== rpId && !parsed.hostname.endsWith(`.${rpId}`))) throw new Error("WEBAUTHN_CONFIGURATION_INVALID");
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && rpId === "localhost")) throw new Error("WEBAUTHN_CONFIGURATION_INVALID");
  return { rpId, origin };
}

function demoEnrollmentUser(): string {
  if (process.env.PARLANCE_DEMO_WEBAUTHN_ENROLLMENT !== "true") throw new Error("DEMO_WEBAUTHN_ENROLLMENT_DISABLED");
  const userId = process.env.PARLANCE_DEMO_USER_ID?.trim();
  if (!userId) throw new Error("DEMO_WEBAUTHN_USER_MISSING");
  return userId;
}

const simpleWebAuthnVerifier: RegistrationVerifier = {
  verify: (input) => verifyRegistrationResponse({
    response: input.response,
    expectedChallenge: input.expectedChallenge,
    expectedOrigin: input.expectedOrigin,
    expectedRPID: input.expectedRpId,
    requireUserPresence: true,
    requireUserVerification: true,
  }),
};

export class WebAuthnService {
  constructor(
    private readonly repository: ParlanceRepository & WebAuthnRepository,
    private readonly bank: BankPort,
    private readonly verifier: RegistrationVerifier = simpleWebAuthnVerifier,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async registrationOptions() {
    const config = webAuthnConfig();
    const userId = demoEnrollmentUser();
    if (!(await this.repository.webAuthnUserExists(userId))) throw new Error("DEMO_WEBAUTHN_USER_NOT_FOUND");
    const existing = await this.repository.listActiveWebAuthnCredentials(userId);
    const userHandle = existing[0]?.userHandle ?? new Uint8Array(randomBytes(32));
    const challengeBytes = randomChallenge();
    const options = await generateRegistrationOptions({
      rpName: "Parlance",
      rpID: config.rpId,
      userID: userHandle,
      userName: userId,
      userDisplayName: "Parlance demo user",
      challenge: challengeBytes,
      timeout: CHALLENGE_TTL_MS,
      attestationType: "none",
      excludeCredentials: existing.map((credential) => ({ id: credential.credentialId, transports: credential.transports })),
      authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
    });
    const issuedAt = this.now();
    const stored = await this.repository.createWebAuthnChallenge({
      id: randomUUID(), userId, purpose: "REGISTRATION", challenge: options.challenge, userHandle,
      expectedRpId: config.rpId, expectedOrigin: config.origin,
      expiresAt: new Date(issuedAt.getTime() + CHALLENGE_TTL_MS),
    });
    return { challengeId: stored.id, options };
  }

  async verifyRegistration(challengeId: string, response: RegistrationResponseJSON) {
    const config = webAuthnConfig();
    const demoUserId = demoEnrollmentUser();
    const challenge = await this.repository.getWebAuthnChallenge(challengeId);
    if (!challenge || challenge.purpose !== "REGISTRATION" || challenge.userId !== demoUserId) throw new Error("WEBAUTHN_REGISTRATION_CHALLENGE_INVALID");
    if (challenge.status !== "ISSUED" || challenge.revokedAt) throw new Error("WEBAUTHN_REGISTRATION_CHALLENGE_INVALID");
    const now = this.now();
    if (challenge.expiresAt.getTime() <= now.getTime()) {
      await this.repository.expireWebAuthnChallenge(challenge.id, now);
      throw new Error("WEBAUTHN_REGISTRATION_CHALLENGE_EXPIRED");
    }
    if (challenge.expectedRpId !== config.rpId || challenge.expectedOrigin !== config.origin || !challenge.userHandle) throw new Error("WEBAUTHN_REGISTRATION_CHALLENGE_INVALID");
    let verification;
    try {
      verification = await this.verifier.verify({ response, expectedChallenge: challenge.challenge, expectedOrigin: challenge.expectedOrigin, expectedRpId: challenge.expectedRpId });
    } catch {
      throw new Error("WEBAUTHN_REGISTRATION_VERIFICATION_FAILED");
    }
    if (!verification.verified || !verification.registrationInfo?.userVerified) throw new Error("WEBAUTHN_REGISTRATION_VERIFICATION_FAILED");
    const info = verification.registrationInfo;
    const credential = {
      id: randomUUID(), userId: challenge.userId, credentialId: info.credential.id,
      publicKey: new Uint8Array(info.credential.publicKey), userHandle: challenge.userHandle,
      signCount: info.credential.counter, transports: info.credential.transports ?? [],
      deviceType: info.credentialDeviceType, backedUp: info.credentialBackedUp,
    };
    const consumed = await this.repository.consumeRegistrationChallenge({ challengeId: challenge.id, userId: challenge.userId, now, credential });
    if (!consumed) throw new Error("WEBAUTHN_REGISTRATION_CHALLENGE_ALREADY_USED");
    return { credentialId: credential.credentialId, userId: credential.userId, verified: true as const };
  }

  async approvalOptions(planId: string, traceId: string) {
    const config = webAuthnConfig();
    const storedPlan = await this.repository.getPlan(planId);
    if (!storedPlan) throw new Error("PLAN_NOT_FOUND");
    const storedGoal = await this.repository.getConfirmedGoal(storedPlan.plan.goalContractId);
    if (!storedGoal) throw new Error("CONFIRMED_GOAL_NOT_FOUND");
    if (storedGoal.contract.version !== storedPlan.plan.goalContractVersion || hashGoalContract(storedGoal.contract) !== storedGoal.contract.contractHash || hashFinancialPlan(storedPlan.plan) !== storedPlan.plan.planHash) throw new Error("APPROVAL_HASH_MISMATCH");
    const snapshot = await this.bank.getState(storedGoal.contract.userId, traceId);
    await this.repository.saveSnapshot(snapshot, traceId);
    if (snapshot.stateVersion !== storedPlan.plan.bankStateVersion) throw new Error("APPROVAL_STATE_CHANGED");
    const credentials = await this.repository.listActiveWebAuthnCredentials(storedGoal.contract.userId);
    if (credentials.length === 0) throw new Error("PASSKEY_CREDENTIAL_NOT_FOUND");
    const issuedAt = this.now();
    const approvalExpiresAt = new Date(issuedAt.getTime() + APPROVAL_TTL_MS);
    const { payload, payloadHash } = buildApprovalPayload({ goal: storedGoal.contract, plan: storedPlan.plan, bankStateVersion: snapshot.stateVersion, approvalExpiresAt });
    const challengeBytes = randomChallenge();
    const options = await generateAuthenticationOptions({
      rpID: config.rpId,
      challenge: challengeBytes,
      timeout: CHALLENGE_TTL_MS,
      userVerification: "required",
      allowCredentials: credentials.map((credential) => ({ id: credential.credentialId, transports: credential.transports })),
    });
    const stored = await this.repository.createWebAuthnChallenge({
      id: randomUUID(), userId: storedGoal.contract.userId, purpose: "APPROVAL", challenge: options.challenge,
      expectedRpId: config.rpId, expectedOrigin: config.origin, financialPlanId: storedPlan.plan.id,
      approvalPayload: payload, approvalPayloadHash: payloadHash,
      expiresAt: new Date(issuedAt.getTime() + CHALLENGE_TTL_MS),
    });
    return { challengeId: stored.id, approvalExpiresAt: approvalExpiresAt.toISOString(), approvalPayloadHash: payloadHash, options };
  }
}
