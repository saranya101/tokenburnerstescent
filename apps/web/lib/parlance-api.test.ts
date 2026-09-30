import { expect, it, vi } from "vitest";
import { createParlanceApi, type AuthenticationCredentialJSON } from "./parlance-api";

const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
const credential: AuthenticationCredentialJSON = { id: "cred", rawId: "cred", type: "public-key", response: { clientDataJSON: "client", authenticatorData: "auth", signature: "signature" }, clientExtensionResults: {} };

it("sends only endpoint-authorized customer fields and exposes no direct approval fallback", async () => {
  const fetcher = vi.fn()
    .mockResolvedValueOnce(json({ status: "AWAITING_GOAL_CONFIRMATION", candidateId: "candidate-1", goalCandidate: { schemaVersion: "1", goal: { type: "PAY_BILL", billerId: "biller-1" }, constraints: [], preferences: [], entityBindings: [] } }))
    .mockResolvedValueOnce(json({ challengeId: "challenge-1", options: { challenge: "challenge" }, approvalExpiresAt: "secret-server-binding", approvalPayloadHash: "secret-server-hash" }))
    .mockResolvedValueOnce(json({ execution: { schemaVersion: "1", executionId: "execution-1", planId: "plan-1", status: "PENDING", startedStateVersion: 7, steps: [], goalOutcome: { achieved: false, summary: "Pending." } } }));
  const api = createParlanceApi(fetcher as typeof fetch);
  await api.sendMessage("Pay my bill"); await api.approvalOptions("plan-1"); await api.verifyApproval("plan-1", "challenge-1", credential);
  const calls = fetcher.mock.calls.map(([url, init]) => ({ url, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) }));
  expect(calls).toEqual([
    { url: "/api/parlance/messages", body: { text: "Pay my bill" } },
    { url: "/api/parlance/plans/plan-1/approval-options", body: {} },
    { url: "/api/parlance/plans/plan-1/approval-verify", body: { challengeId: "challenge-1", credential } },
  ]);
  expect(JSON.stringify(calls)).not.toMatch(/financialPlanHash|goalContractHash|bankStateVersion|approvalExpiresAt|approvalPayloadHash|signatureReference|approvalId/u);
  expect(Object.keys(api)).not.toContain("approve"); expect(calls.some((call) => /\/approve$/u.test(String(call.url)))).toBe(false);
});

it("sends a strict empty body when the customer explicitly confirms meaning", async () => {
  const fetcher = vi.fn().mockResolvedValue(json({ goalContract: {
    schemaVersion: "1", id: "goal-1", userId: "user-1", version: 1,
    goal: { type: "DELIVER_MONEY", amount: { currency: "USD", minorUnits: "700000" }, recipientId: "beneficiary-ntu" },
    constraints: [], preferences: [], entityBindings: [], status: "CONFIRMED", contractHash: "goal-hash-0000001",
    createdAt: "2026-09-28T00:00:00.000Z", confirmedAt: "2026-09-28T00:01:00.000Z",
  } }));
  const api = createParlanceApi(fetcher as typeof fetch); await api.confirmGoal("candidate-1");
  expect(fetcher).toHaveBeenCalledOnce();
  expect(fetcher).toHaveBeenCalledWith("/api/parlance/goal-candidates/candidate-1/confirm", expect.objectContaining({ method: "POST", body: "{}" }));
});

it("uses only server-bound passkey enrollment endpoints", async () => {
  const fetcher = vi.fn()
    .mockResolvedValueOnce(json({ status: "NOT_ENROLLED", userVerification: "required" }))
    .mockResolvedValueOnce(json({ challengeId: "registration-1", options: { challenge: "challenge", user: { id: "handle", name: "customer", displayName: "Customer" } } }))
    .mockResolvedValueOnce(json({ verified: true }));
  const api = createParlanceApi(fetcher as typeof fetch);
  const status = await api.passkeyStatus(); const issued = await api.registrationOptions();
  const registration = { id: "credential", rawId: "credential", type: "public-key" as const, response: { clientDataJSON: "client", attestationObject: "attestation", transports: [] }, clientExtensionResults: {} };
  await api.verifyRegistration(issued.challengeId, registration);
  expect(status.status).toBe("NOT_ENROLLED");
  expect(fetcher.mock.calls.map(([url, init]) => ({ url, method: init?.method, body: init?.body }))).toEqual([
    { url: "/api/parlance/webauthn/registration/status", method: "GET", body: undefined },
    { url: "/api/parlance/webauthn/registration/options", method: "POST", body: "{}" },
    { url: "/api/parlance/webauthn/registration/verify", method: "POST", body: JSON.stringify({ challengeId: "registration-1", credential: registration }) },
  ]);
});
