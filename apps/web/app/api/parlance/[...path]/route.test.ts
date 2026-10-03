import { NextRequest } from "next/server";
import { afterEach, expect, it, vi } from "vitest";
import { GET, POST } from "./route";

afterEach(() => { vi.unstubAllGlobals(); delete process.env.PARLANCE_CUSTOMER_USER_ID; delete process.env.API_URL; });

it("injects the configured server-side customer identity into message requests", async () => {
  process.env.PARLANCE_CUSTOMER_USER_ID = "user-1"; process.env.API_URL = "http://api.internal:4001";
  const upstream = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: "NEEDS_CLARIFICATION", clarifications: [] }), { status: 200, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", upstream);
  const response = await POST(new NextRequest("http://localhost/api/parlance/messages", { method: "POST", body: JSON.stringify({ text: "Send money" }), headers: { "content-type": "application/json" } }), { params: Promise.resolve({ path: ["messages"] }) });
  expect(response.status).toBe(200);
  expect(upstream).toHaveBeenCalledWith("http://api.internal:4001/v1/messages", expect.objectContaining({ body: JSON.stringify({ userId: "user-1", text: "Send money" }) }));
});

it("forwards validated voice provenance through the same server-bound message route", async () => {
  process.env.PARLANCE_CUSTOMER_USER_ID = "user-1"; process.env.API_URL = "http://api.internal:4001";
  const upstream = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: "SEMANTIC_VALIDATION_FAILED", message: "Please clarify." }), { status: 200 })); vi.stubGlobal("fetch", upstream);
  const voice = { rawTranscript: "Send John USD 300", provider: "browser-web-speech", transcribedAt: "2026-10-03T10:00:00.000Z" };
  const response = await POST(new NextRequest("http://localhost/api/parlance/messages", { method: "POST", body: JSON.stringify({ text: "Send John USD 3000", inputMode: "VOICE", voice }), headers: { "content-type": "application/json" } }), { params: Promise.resolve({ path: ["messages"] }) });
  expect(response.status).toBe(200);
  expect(upstream).toHaveBeenCalledWith("http://api.internal:4001/v1/messages", expect.objectContaining({ body: JSON.stringify({ userId: "user-1", text: "Send John USD 3000", inputMode: "VOICE", voice }) }));
});

it("does not expose the removed direct approval path", async () => {
  const upstream = vi.fn(); vi.stubGlobal("fetch", upstream);
  const response = await POST(new NextRequest("http://localhost/api/parlance/plans/plan-1/approve", { method: "POST", body: "{}" }), { params: Promise.resolve({ path: ["plans", "plan-1", "approve"] }) });
  expect(response.status).toBe(404); expect(upstream).not.toHaveBeenCalled();
});

it("allows the read-only customer passkey status route", async () => {
  process.env.API_URL = "http://api.internal:4001";
  const upstream = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: "READY", userVerification: "required" }), { status: 200, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", upstream);
  const response = await GET(new NextRequest("http://localhost/api/parlance/webauthn/registration/status"), { params: Promise.resolve({ path: ["webauthn", "registration", "status"] }) });
  expect(response.status).toBe(200); expect(upstream).toHaveBeenCalledWith("http://api.internal:4001/v1/webauthn/registration/status", expect.objectContaining({ method: "GET", cache: "no-store" }));
});

it("allows only the explicitly whitelisted customer state GET", async () => {
  process.env.API_URL = "http://api.internal:4001";
  const upstream = vi.fn().mockResolvedValue(new Response(JSON.stringify({ schemaVersion: "1", userId: "configured-user" }), { status: 200, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", upstream);
  const allowed = await GET(new NextRequest("http://localhost/api/parlance/customer/state?userId=ignored"), { params: Promise.resolve({ path: ["customer", "state"] }) });
  expect(allowed.status).toBe(200);
  expect(upstream).toHaveBeenCalledWith("http://api.internal:4001/v1/customer/state", expect.objectContaining({ method: "GET", cache: "no-store" }));
  const blocked = await GET(new NextRequest("http://localhost/api/parlance/customer/anything-else"), { params: Promise.resolve({ path: ["customer", "anything-else"] }) });
  expect(blocked.status).toBe(404); expect(upstream).toHaveBeenCalledOnce();
});

it("proxies a clarification answer without adding authoritative fields", async () => {
  process.env.API_URL = "http://api.internal:4001";
  const upstream = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: "AWAITING_GOAL_CONFIRMATION", candidateId: "candidate-1", goalCandidate: {} }), { status: 200, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", upstream);
  const response = await POST(new NextRequest("http://localhost/api/parlance/clarifications/clarification-1/answer", { method: "POST", body: JSON.stringify({ selectedCandidateId: "acc-1" }), headers: { "content-type": "application/json" } }), { params: Promise.resolve({ path: ["clarifications", "clarification-1", "answer"] }) });
  expect(response.status).toBe(200);
  expect(upstream).toHaveBeenCalledWith("http://api.internal:4001/v1/clarifications/clarification-1/answer", expect.objectContaining({ body: JSON.stringify({ selectedCandidateId: "acc-1" }) }));
});
