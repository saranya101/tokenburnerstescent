import { NextRequest } from "next/server";
import { afterEach, expect, it, vi } from "vitest";
import { GET, POST } from "./route";

const configure = () => { process.env.PARLANCE_CUSTOMER_USER_ID = "user-1"; process.env.PARLANCE_INTERNAL_API_TOKEN = "internal-test-token"; process.env.API_URL = "http://api.internal:4001"; };

afterEach(() => { vi.unstubAllGlobals(); delete process.env.PARLANCE_CUSTOMER_USER_ID; delete process.env.PARLANCE_INTERNAL_API_TOKEN; delete process.env.API_URL; });

it("injects the configured server-side customer identity into message requests", async () => {
  configure();
  const upstream = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: "NEEDS_CLARIFICATION", clarifications: [] }), { status: 200, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", upstream);
  const response = await POST(new NextRequest("http://localhost/api/parlance/messages", { method: "POST", body: JSON.stringify({ text: "Send money" }), headers: { "content-type": "application/json" } }), { params: Promise.resolve({ path: ["messages"] }) });
  expect(response.status).toBe(200);
  expect(upstream).toHaveBeenCalledWith("http://api.internal:4001/v1/messages", expect.objectContaining({
    body: JSON.stringify({ text: "Send money" }),
    headers: expect.objectContaining({ "x-parlance-customer-id": "user-1", "x-parlance-internal-token": "internal-test-token" }),
  }));
});

it("forwards validated voice provenance through the same server-bound message route", async () => {
  configure();
  const upstream = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: "SEMANTIC_VALIDATION_FAILED", message: "Please clarify." }), { status: 200 })); vi.stubGlobal("fetch", upstream);
  const voice = { rawTranscript: "Send John USD 300", provider: "browser-web-speech", transcribedAt: "2026-10-03T10:00:00.000Z" };
  const response = await POST(new NextRequest("http://localhost/api/parlance/messages", { method: "POST", body: JSON.stringify({ text: "Send John USD 3000", inputMode: "VOICE", voice }), headers: { "content-type": "application/json" } }), { params: Promise.resolve({ path: ["messages"] }) });
  expect(response.status).toBe(200);
  expect(upstream).toHaveBeenCalledWith("http://api.internal:4001/v1/messages", expect.objectContaining({ body: JSON.stringify({ text: "Send John USD 3000", inputMode: "VOICE", voice }) }));
});

it("does not expose the removed direct approval path", async () => {
  const upstream = vi.fn(); vi.stubGlobal("fetch", upstream);
  const response = await POST(new NextRequest("http://localhost/api/parlance/plans/plan-1/approve", { method: "POST", body: "{}" }), { params: Promise.resolve({ path: ["plans", "plan-1", "approve"] }) });
  expect(response.status).toBe(404); expect(upstream).not.toHaveBeenCalled();
});

it("allows the read-only customer passkey status route", async () => {
  configure();
  const upstream = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: "READY", userVerification: "required" }), { status: 200, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", upstream);
  const response = await GET(new NextRequest("http://localhost/api/parlance/webauthn/registration/status"), { params: Promise.resolve({ path: ["webauthn", "registration", "status"] }) });
  expect(response.status).toBe(200); expect(upstream).toHaveBeenCalledWith("http://api.internal:4001/v1/webauthn/registration/status", expect.objectContaining({ method: "GET", cache: "no-store" }));
});

it("allows only the explicitly whitelisted customer state GET", async () => {
  configure();
  const upstream = vi.fn().mockResolvedValue(new Response(JSON.stringify({ schemaVersion: "1", userId: "configured-user" }), { status: 200, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", upstream);
  const allowed = await GET(new NextRequest("http://localhost/api/parlance/customer/state?userId=ignored"), { params: Promise.resolve({ path: ["customer", "state"] }) });
  expect(allowed.status).toBe(200);
  expect(upstream).toHaveBeenCalledWith("http://api.internal:4001/v1/customer/state", expect.objectContaining({ method: "GET", cache: "no-store" }));
  const blocked = await GET(new NextRequest("http://localhost/api/parlance/customer/anything-else"), { params: Promise.resolve({ path: ["customer", "anything-else"] }) });
  expect(blocked.status).toBe(404); expect(upstream).toHaveBeenCalledOnce();
});

it("allows only the bounded customer activity GET", async () => {
  configure();
  const upstream = vi.fn().mockResolvedValue(new Response(JSON.stringify({ items: [] }), { status: 200, headers: { "content-type": "application/json" } })); vi.stubGlobal("fetch", upstream);
  const response = await GET(new NextRequest("http://localhost/api/parlance/customer/activity?userId=ignored"), { params: Promise.resolve({ path: ["customer", "activity"] }) });
  expect(response.status).toBe(200); expect(upstream).toHaveBeenCalledWith("http://api.internal:4001/v1/customer/activity", expect.objectContaining({ method: "GET", cache: "no-store" }));
});

it("proxies a clarification answer without adding authoritative fields", async () => {
  configure();
  const upstream = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: "AWAITING_GOAL_CONFIRMATION", candidateId: "candidate-1", goalCandidate: {} }), { status: 200, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", upstream);
  const response = await POST(new NextRequest("http://localhost/api/parlance/clarifications/clarification-1/answer", { method: "POST", body: JSON.stringify({ selectedCandidateId: "acc-1" }), headers: { "content-type": "application/json" } }), { params: Promise.resolve({ path: ["clarifications", "clarification-1", "answer"] }) });
  expect(response.status).toBe(200);
  expect(upstream).toHaveBeenCalledWith("http://api.internal:4001/v1/clarifications/clarification-1/answer", expect.objectContaining({ body: JSON.stringify({ selectedCandidateId: "acc-1" }) }));
});

it("overwrites spoofed trusted headers instead of forwarding browser authority", async () => {
  configure();
  const upstream = vi.fn().mockResolvedValue(new Response(JSON.stringify({ items: [] }), { status: 200 })); vi.stubGlobal("fetch", upstream);
  await GET(new NextRequest("http://localhost/api/parlance/customer/activity", { headers: { "x-parlance-customer-id": "user-alice", "x-parlance-internal-token": "stolen" } }), { params: Promise.resolve({ path: ["customer", "activity"] }) });
  const headers = (upstream.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>;
  expect(headers["x-parlance-customer-id"]).toBe("user-1"); expect(headers["x-parlance-internal-token"]).toBe("internal-test-token");
});

it("fails closed without the server-only internal credential", async () => {
  process.env.PARLANCE_CUSTOMER_USER_ID = "user-1"; process.env.API_URL = "http://api.internal:4001";
  const upstream = vi.fn(); vi.stubGlobal("fetch", upstream);
  const response = await GET(new NextRequest("http://localhost/api/parlance/customer/state"), { params: Promise.resolve({ path: ["customer", "state"] }) });
  expect(response.status).toBe(503); expect(upstream).not.toHaveBeenCalled();
});

it("maps upstream authorization errors without exposing internal token diagnostics", async () => {
  configure(); const upstream = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: "INTERNAL_API_TOKEN_INVALID" }), { status: 401 })); vi.stubGlobal("fetch", upstream);
  const response = await GET(new NextRequest("http://localhost/api/parlance/customer/state"), { params: Promise.resolve({ path: ["customer", "state"] }) });
  expect(response.status).toBe(401); await expect(response.json()).resolves.toEqual({ code: "REQUEST_NOT_AUTHORIZED" });
});
