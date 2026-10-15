import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const auth = vi.hoisted(() => ({ userId: undefined as string | undefined }));
vi.mock("../../../../lib/web-auth", () => ({
  webAuthEnabled: () => true,
  webCustomer: async () => auth.userId ? { userId: auth.userId } : undefined,
  setWebSessionCookies: vi.fn(),
}));
import { GET } from "./route";

const bankState = JSON.parse(readFileSync(resolve(process.cwd(), "../../packages/contracts/fixtures/02-apple-investment/bank-state.json"), "utf8")) as Record<string, unknown>;
beforeEach(() => {
  auth.userId = undefined;
  process.env.PARLANCE_INTERNAL_API_TOKEN = "internal-test-token";
  process.env.API_URL = "http://private-api:4001";
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.PARLANCE_INTERNAL_API_TOKEN;
  delete process.env.API_URL;
});

it("does not call the banking API for an anonymous browser", async () => {
  const upstream = vi.fn(); vi.stubGlobal("fetch", upstream);
  expect((await GET(new NextRequest("https://bank.example/api/web-auth/session"))).status).toBe(401);
  expect(upstream).not.toHaveBeenCalled();
});

it("marks the browser ready only after an authoritative matching customer state read", async () => {
  auth.userId = "customer-a";
  const upstream = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ ...bankState, userId: "customer-a" }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ items: [] }), { status: 200 }));
  vi.stubGlobal("fetch", upstream);
  const response = await GET(new NextRequest("https://bank.example/api/web-auth/session"));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ authenticated: true, financialExecutionEnabled: false });
  expect(upstream).toHaveBeenCalledWith("http://private-api:4001/v1/customer/state", expect.objectContaining({
    headers: { "x-parlance-internal-token": "internal-test-token", "x-parlance-customer-id": "customer-a" },
  }));
  expect(upstream).toHaveBeenCalledWith("http://private-api:4001/v1/customer/activity", expect.objectContaining({
    headers: { "x-parlance-internal-token": "internal-test-token", "x-parlance-customer-id": "customer-a" },
  }));
});

it("does not reveal the dashboard when the upstream state belongs to another customer", async () => {
  auth.userId = "customer-a";
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ ...bankState, userId: "customer-b" }), { status: 200 })));
  expect((await GET(new NextRequest("https://bank.example/api/web-auth/session"))).status).toBe(503);
});

it("does not reveal the dashboard when customer activity is unavailable", async () => {
  auth.userId = "customer-a";
  vi.stubGlobal("fetch", vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ ...bankState, userId: "customer-a" }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ code: "CUSTOMER_ACTIVITY_UNAVAILABLE" }), { status: 503 })));
  expect((await GET(new NextRequest("https://bank.example/api/web-auth/session"))).status).toBe(503);
});
