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
  for (const key of ["PARLANCE_PUBLIC_SAFE_MODE", "PARLANCE_CUSTOMER_USER_ID", "PARLANCE_INTERNAL_API_TOKEN", "API_URL"]) delete process.env[key];
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

it("rejects path traversal and oversized public requests", async () => {
  auth.userId = "mapped-customer";
  const upstream = vi.fn(); vi.stubGlobal("fetch", upstream);
  const traversal = await POST(new NextRequest("https://bank.example/api/parlance/goal-candidates/%2e%2e/confirm", { method: "POST", headers: { origin: "https://bank.example" }, body: "{}" }), context("goal-candidates", "..", "confirm"));
  const oversized = await POST(new NextRequest("https://bank.example/api/parlance/messages", { method: "POST", headers: { origin: "https://bank.example" }, body: JSON.stringify({ text: "x".repeat(33000) }) }), context("messages"));
  expect(traversal.status).toBe(404);
  expect(oversized.status).toBe(413);
  expect(upstream).not.toHaveBeenCalled();
});
