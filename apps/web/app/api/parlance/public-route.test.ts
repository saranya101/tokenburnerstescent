import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const auth = vi.hoisted(() => ({ userId: undefined as string | undefined }));
vi.mock("../../../lib/web-auth", () => ({
  webAuthEnabled: () => true,
  sameOrigin: (request: NextRequest) => request.headers.get("origin") === "https://bank.example",
  webCustomer: async () => auth.userId ? { userId: auth.userId } : undefined,
  setWebSessionCookies: vi.fn(),
}));
import { GET, POST } from "./[...path]/route";

const context = (...path: string[]) => ({ params: Promise.resolve({ path }) });
beforeEach(() => {
  process.env.PARLANCE_PUBLIC_SAFE_MODE = "true";
  process.env.PARLANCE_CUSTOMER_USER_ID = "fixed-legacy-customer";
  process.env.PARLANCE_INTERNAL_API_TOKEN = "internal-test-token";
  process.env.API_URL = "http://private-api:4001";
  auth.userId = undefined;
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const key of ["PARLANCE_PUBLIC_SAFE_MODE", "PARLANCE_PUBLIC_PASSKEY_ENROLLMENT_ENABLED", "PARLANCE_PUBLIC_PASSKEY_EXECUTION_ENABLED", "PARLANCE_BANK_DURABLE_EXECUTION", "PARLANCE_ISOLATED_SYNTHETIC_EXECUTION_APPROVED", "PARLANCE_CUSTOMER_USER_ID", "PARLANCE_INTERNAL_API_TOKEN", "API_URL"]) delete process.env[key];
});

it("rejects anonymous requests even when a fixed legacy customer is configured", async () => {
  const upstream = vi.fn(); vi.stubGlobal("fetch", upstream);
  const response = await GET(new NextRequest("https://bank.example/api/parlance/customer/state"), context("customer", "state"));
  expect(response.status).toBe(401);
  expect(upstream).not.toHaveBeenCalled();
});

it("forwards only the verified session customer and ignores spoofed authority headers", async () => {
  auth.userId = "mapped-customer";
  const upstream = vi.fn().mockResolvedValue(new Response("{}", { status: 200 })); vi.stubGlobal("fetch", upstream);
  const response = await GET(new NextRequest("https://bank.example/api/parlance/customer/state", { headers: {
    "x-parlance-customer-id": "other-customer", "x-parlance-internal-token": "attacker",
  } }), context("customer", "state"));
  expect(response.status).toBe(200);
  const headers = upstream.mock.calls[0]![1].headers as Record<string, string>;
  expect(headers["x-parlance-customer-id"]).toBe("mapped-customer");
  expect(headers["x-parlance-internal-token"]).toBe("internal-test-token");
});

it("blocks public execution and cross-origin mutations before reaching the API", async () => {
  auth.userId = "mapped-customer";
  const upstream = vi.fn(); vi.stubGlobal("fetch", upstream);
  const execution = await POST(new NextRequest("https://bank.example/api/parlance/executions/run-1/run", { method: "POST", body: "{}" }), context("executions", "run-1", "run"));
  const csrf = await POST(new NextRequest("https://bank.example/api/parlance/messages", { method: "POST", headers: { origin: "https://evil.example" }, body: "{}" }), context("messages"));
  expect(execution.status).toBe(404);
  expect(csrf.status).toBe(403);
  expect(upstream).not.toHaveBeenCalled();
});

it("keeps enrollment closed by default and requires a customer session when enabled", async () => {
  const upstream = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: "NOT_ENROLLED" }), { status: 200 }));
  vi.stubGlobal("fetch", upstream);
  const url = "https://bank.example/api/parlance/webauthn/registration/status";
  auth.userId = "mapped-customer";
  expect((await GET(new NextRequest(url), context("webauthn", "registration", "status"))).status).toBe(404);
  process.env.PARLANCE_PUBLIC_PASSKEY_ENROLLMENT_ENABLED = "true";
  auth.userId = undefined;
  expect((await GET(new NextRequest(url), context("webauthn", "registration", "status"))).status).toBe(401);
  expect(upstream).not.toHaveBeenCalled();
  auth.userId = "mapped-customer";
  expect((await GET(new NextRequest(url), context("webauthn", "registration", "status"))).status).toBe(200);
  const headers = upstream.mock.calls[0]![1].headers as Record<string, string>;
  expect(headers["x-parlance-customer-id"]).toBe("mapped-customer");
});

it("permits only same-origin enrollment mutations while approval and execution stay closed", async () => {
  process.env.PARLANCE_PUBLIC_PASSKEY_ENROLLMENT_ENABLED = "true";
  auth.userId = "mapped-customer";
  const upstream = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", upstream);
  const options = "https://bank.example/api/parlance/webauthn/registration/options";
  expect((await POST(new NextRequest(options, { method: "POST", headers: { origin: "https://evil.example" }, body: "{}" }), context("webauthn", "registration", "options"))).status).toBe(403);
  expect((await POST(new NextRequest(options, { method: "POST", headers: { origin: "https://bank.example" }, body: "{}" }), context("webauthn", "registration", "options"))).status).toBe(200);
  expect((await POST(new NextRequest("https://bank.example/api/parlance/plans/p1/approval-options", { method: "POST", headers: { origin: "https://bank.example" }, body: "{}" }), context("plans", "p1", "approval-options"))).status).toBe(404);
  expect((await POST(new NextRequest("https://bank.example/api/parlance/executions/e1/run", { method: "POST", headers: { origin: "https://bank.example" }, body: "{}" }), context("executions", "e1", "run"))).status).toBe(404);
  expect(upstream).toHaveBeenCalledTimes(1);
});

it("opens exact-plan routes only with all durable execution gates and a same-origin customer session", async () => {
  const upstream = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", upstream);
  const url = "https://bank.example/api/parlance/plans/p1/approval-options";
  const request = () => new NextRequest(url, { method: "POST", headers: { origin: "https://bank.example" }, body: "{}" });
  auth.userId = "mapped-customer";
  process.env.PARLANCE_PUBLIC_PASSKEY_ENROLLMENT_ENABLED = "true";
  process.env.PARLANCE_PUBLIC_PASSKEY_EXECUTION_ENABLED = "true";
  process.env.PARLANCE_BANK_DURABLE_EXECUTION = "true";
  expect((await POST(request(), context("plans", "p1", "approval-options"))).status).toBe(404);
  process.env.PARLANCE_ISOLATED_SYNTHETIC_EXECUTION_APPROVED = "true";
  auth.userId = undefined;
  expect((await POST(request(), context("plans", "p1", "approval-options"))).status).toBe(401);
  auth.userId = "mapped-customer";
  expect((await POST(new NextRequest(url, { method: "POST", headers: { origin: "https://evil.example" }, body: "{}" }), context("plans", "p1", "approval-options"))).status).toBe(403);
  expect((await POST(request(), context("plans", "p1", "approval-options"))).status).toBe(200);
  const forwarded = upstream.mock.calls[0]![1].headers as Record<string, string>;
  expect(forwarded["x-parlance-customer-id"]).toBe("mapped-customer");
  expect((await POST(new NextRequest("https://bank.example/api/parlance/ops/runs", { method: "POST", headers: { origin: "https://bank.example" }, body: "{}" }), context("ops", "runs"))).status).toBe(404);
});

it("rejects path traversal and oversized public requests", async () => {
  auth.userId = "mapped-customer";
  const upstream = vi.fn(); vi.stubGlobal("fetch", upstream);
  const traversal = await POST(new NextRequest("https://bank.example/api/parlance/goal-candidates/%2e%2e/confirm", { method: "POST", headers: { origin: "https://bank.example" }, body: "{}" }), context("goal-candidates", "..", "confirm"));
  const oversized = await POST(new NextRequest("https://bank.example/api/parlance/messages", { method: "POST", headers: { origin: "https://bank.example" }, body: JSON.stringify({ text: "x".repeat(33000) }) }), context("messages"));
  expect(traversal.status).toBe(404);
  expect(oversized.status).toBe(413);
  expect(upstream).not.toHaveBeenCalled();
});
