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
