import type { ApprovalV1, ExecutionResultV1 } from "@parlance/contracts";
import type { AuthenticationResponseJSON, RegistrationResponseJSON, VerifiedAuthenticationResponse, VerifiedRegistrationResponse, WebAuthnCredential } from "@simplewebauthn/server";

export type WebAuthnChallengePurpose = "REGISTRATION" | "APPROVAL";
export type WebAuthnChallengeStatus = "ISSUED" | "CONSUMED" | "REVOKED" | "EXPIRED";

export interface ApprovalPayload {
  purpose: "PARLANCE_FINANCIAL_PLAN_APPROVAL";
  payloadVersion: 1;
  approvalMethod: "PASSKEY";
  userId: string;
  goalContractId: string;
  goalContractVersion: number;
  goalContractHash: string;
  financialPlanId: string;
  financialPlanHash: string;
  bankStateVersion: number;
  approvalExpiresAt: string;
}

export interface StoredWebAuthnCredential {
  id: string;
  userId: string;
  credentialId: string;
  publicKey: Uint8Array<ArrayBuffer>;
  userHandle: Uint8Array<ArrayBuffer>;
  signCount: number;
  transports: string[];
  deviceType: string;
  backedUp: boolean;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

export interface NewWebAuthnCredential {
  id: string;
  userId: string;
  credentialId: string;
  publicKey: Uint8Array<ArrayBuffer>;
  userHandle: Uint8Array<ArrayBuffer>;
  signCount: number;
  transports: string[];
  deviceType: string;
  backedUp: boolean;
}

export interface StoredWebAuthnChallenge {
  id: string;
  userId: string;
  purpose: WebAuthnChallengePurpose;
  challenge: string;
  userHandle: Uint8Array<ArrayBuffer> | null;
  expectedRpId: string;
  expectedOrigin: string;
  status: WebAuthnChallengeStatus;
  financialPlanId: string | null;
  approvalPayload: ApprovalPayload | null;
  approvalPayloadHash: string | null;
  expiresAt: Date;
  consumedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

export interface NewWebAuthnChallenge {
  id: string;
  userId: string;
  purpose: WebAuthnChallengePurpose;
  challenge: string;
  userHandle?: Uint8Array<ArrayBuffer>;
  expectedRpId: string;
  expectedOrigin: string;
  financialPlanId?: string;
  approvalPayload?: ApprovalPayload;
  approvalPayloadHash?: string;
  expiresAt: Date;
}

export interface StoredApprovalEvidence {
  id: string;
  approvalId: string;
  userId: string;
  financialPlanId: string;
  goalContractKey: string;
  goalContractVersion: number;
  goalContractHash: string;
  financialPlanHash: string;
  bankStateVersion: number;
  webAuthnCredentialId: string;
  challengeId: string;
  approvalPayloadHash: string;
  authenticatorCounterBefore: number;
  authenticatorCounterAfter: number;
  userVerified: boolean;
  rpId: string;
  origin: string;
  verifiedAt: string;
}

export interface VerifiedPasskeyAuthorizationInput {
  goalRowId: string;
  approval: ApprovalV1;
  executionId: string;
  evidence: StoredApprovalEvidence;
  challengeId: string;
  credentialId: string;
  expectedCounter: number;
  newCounter: number;
  now: Date;
  traceId: string;
}

export interface WebAuthnRepository {
  webAuthnUserExists(userId: string): Promise<boolean>;
  createWebAuthnChallenge(challenge: NewWebAuthnChallenge): Promise<StoredWebAuthnChallenge>;
  getWebAuthnChallenge(id: string): Promise<StoredWebAuthnChallenge | null>;
  expireWebAuthnChallenge(id: string, now: Date): Promise<boolean>;
  revokeWebAuthnChallenge(id: string, now: Date): Promise<boolean>;
  consumeRegistrationChallenge(input: { challengeId: string; userId: string; now: Date; credential: NewWebAuthnCredential }): Promise<boolean>;
  saveWebAuthnCredential(credential: NewWebAuthnCredential): Promise<StoredWebAuthnCredential>;
  getWebAuthnCredential(credentialId: string): Promise<StoredWebAuthnCredential | null>;
  listActiveWebAuthnCredentials(userId: string): Promise<StoredWebAuthnCredential[]>;
  revokeWebAuthnCredential(credentialId: string, userId: string, now: Date): Promise<boolean>;
  authorizeVerifiedPasskey(input: VerifiedPasskeyAuthorizationInput): Promise<{ evidence: StoredApprovalEvidence; execution: ExecutionResultV1 }>;
}

export interface RegistrationVerifier {
  verify(input: { response: RegistrationResponseJSON; expectedChallenge: string; expectedOrigin: string; expectedRpId: string }): Promise<VerifiedRegistrationResponse>;
}

export interface AuthenticationVerifier {
  verify(input: {
    response: AuthenticationResponseJSON;
    expectedChallenge: string;
    expectedOrigin: string;
    expectedRpId: string;
    credential: WebAuthnCredential;
  }): Promise<VerifiedAuthenticationResponse>;
}
