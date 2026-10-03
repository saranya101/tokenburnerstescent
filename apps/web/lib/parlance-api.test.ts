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

it("sends no client bundle payload or hash when confirming combined meaning", async () => {
  const contract = { schemaVersion: "1", bundleId: "bundle-1", bundleVersion: 1, items: [{ itemId: "item-1", goal: { type: "ACQUIRE_ASSET", assetId: "asset-aapl", quantity: "1" }, constraints: [], preferences: [], bindings: [] }], globalConstraints: [], explicitDependencies: [], contractHash: "b".repeat(64) };
  const fetcher = vi.fn().mockResolvedValue(json({ goalBundleContract: contract }));
  const api = createParlanceApi(fetcher as typeof fetch); await api.confirmGoalBundle("candidate-bundle");
  expect(fetcher).toHaveBeenCalledWith("/api/parlance/goal-bundle-candidates/candidate-bundle/confirm", expect.objectContaining({ method: "POST", body: "{}" }));
  expect(String(fetcher.mock.calls[0]?.[1]?.body)).not.toMatch(/bundleId|contractHash|items/u);
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

it("continues clarification with only the request identifier and customer answer", async () => {
  const fetcher = vi.fn().mockResolvedValue(json({ status: "AWAITING_GOAL_CONFIRMATION", candidateId: "candidate-1", goalCandidate: { schemaVersion: "1", goal: { type: "PAY_BILL", billerId: "biller-1" }, constraints: [], preferences: [], entityBindings: [] } }));
  const api = createParlanceApi(fetcher as typeof fetch); await api.answerClarification("clarification-1", { selectedCandidateId: "account-1" });
  expect(fetcher).toHaveBeenCalledWith("/api/parlance/clarifications/clarification-1/answer", expect.objectContaining({ method: "POST", body: JSON.stringify({ selectedCandidateId: "account-1" }) }));
});

it("preserves the customer-safe semantic validation failure response", async () => {
  const response = {
    status: "SEMANTIC_VALIDATION_FAILED",
    message: "We couldn't safely verify that we understood your request. Please clarify or rephrase it.",
  } as const;
  const fetcher = vi.fn().mockResolvedValue(json(response));
  const api = createParlanceApi(fetcher as typeof fetch);
  await expect(api.sendMessage("Send USD 7,000 to NTU")).resolves.toEqual(response);
});

it("adds voice provenance to the same messages endpoint and no compiler or bank endpoint", async () => {
  const response = { status: "SEMANTIC_VALIDATION_FAILED", message: "Please clarify." } as const;
  const fetcher = vi.fn().mockResolvedValue(json(response)); const api = createParlanceApi(fetcher as typeof fetch);
  const voice = { inputMode: "VOICE" as const, voice: { rawTranscript: "Send John USD 300", provider: "browser-web-speech", transcribedAt: "2026-10-03T10:00:00.000Z" } };
  await api.sendMessage("Send John USD 3000", voice);
  expect(fetcher).toHaveBeenCalledWith("/api/parlance/messages", expect.objectContaining({ body: JSON.stringify({ text: "Send John USD 3000", ...voice }) }));
  expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual(["/api/parlance/messages"]);
});

it("loads and validates the authoritative customer bank state", async () => {
  const state = {
    schemaVersion: "1", userId: "configured-user", stateVersion: 9, capturedAt: "2026-10-03T00:00:00Z",
    accounts: [{ id: "acc-usd", type: "CHECKING", currency: "USD", ledgerMinorUnits: "449900", availableMinorUnits: "449900", status: "ACTIVE", capabilities: ["SEND_TRANSFER"] }],
    beneficiaries: [], assets: [], holdings: [], obligations: [], serviceAvailability: { transfers: true, fx: true, billPayments: true, investments: true }, fxQuotes: [], assetQuotes: [],
  };
  const fetcher = vi.fn().mockResolvedValue(json(state)); const api = createParlanceApi(fetcher as typeof fetch);
  await expect(api.customerState()).resolves.toEqual(state);
  expect(fetcher).toHaveBeenCalledWith("/api/parlance/customer/state", expect.objectContaining({ method: "GET", cache: "no-store" }));
  const invalid = createParlanceApi(vi.fn().mockResolvedValue(json({ ...state, accounts: [{ ...state.accounts[0], availableMinorUnits: 449900 }] })) as typeof fetch);
  await expect(invalid.customerState()).rejects.toThrow();
});

it("loads and validates customer-safe authoritative activity", async () => {
  const activity = { items: [{ occurredAt: "2026-10-03T10:00:00.000Z", description: "Transfer to John Tan", accountLabel: "USD Account", amount: { currency: "USD", minorUnits: "30000" }, direction: "DEBIT", status: "COMPLETED" }] };
  const fetcher = vi.fn().mockResolvedValue(json(activity)); const api = createParlanceApi(fetcher as typeof fetch);
  await expect(api.customerActivity()).resolves.toEqual(activity);
  expect(fetcher).toHaveBeenCalledWith("/api/parlance/customer/activity", expect.objectContaining({ method: "GET", cache: "no-store" }));
});
