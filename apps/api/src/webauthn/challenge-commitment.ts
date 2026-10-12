import { randomBytes } from "node:crypto";
import { canonicalHash } from "../security/canonical-hash.js";

export const TRANSACTION_APPROVAL_DOMAIN = "PARLANCE_TRANSACTION_APPROVAL_V1";

export function newApprovalChallengeNonce(): string {
  return randomBytes(32).toString("base64url");
}

export function committedApprovalChallenge(approvalPayloadHash: string, nonce: string): string {
  if (!/^[a-f0-9]{64}$/u.test(approvalPayloadHash)) throw new Error("APPROVAL_PAYLOAD_HASH_INVALID");
  if (Buffer.from(nonce, "base64url").byteLength !== 32) throw new Error("APPROVAL_CHALLENGE_NONCE_INVALID");
  const commitment = canonicalHash({
    domain: TRANSACTION_APPROVAL_DOMAIN,
    approvalPayloadHash,
    nonce,
  });
  return Buffer.from(commitment, "hex").toString("base64url");
}
