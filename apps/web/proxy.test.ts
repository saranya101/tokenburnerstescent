import { afterEach, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "./proxy";

afterEach(() => { delete process.env.PARLANCE_PUBLIC_SAFE_MODE; delete process.env.PARLANCE_MOBILE_GATEWAY_ONLY; });

it("keeps development routes available when public safe mode is absent", () => {
  expect(proxy(new NextRequest("https://example.test/api/parlance/customer/state")).status).toBe(200);
});

it("blocks all banking, mobile, demo, and operator endpoints in public safe mode", () => {
  process.env.PARLANCE_PUBLIC_SAFE_MODE = "true";
  for (const path of ["/api", "/api/parlance/customer/state", "/api/parlance/messages", "/api/mobile/session/exchange", "/api/demo/mock-bank", "/api/operator/session", "/ops"]) {
    expect(proxy(new NextRequest(`https://example.test${path}`)).status).toBe(404);
  }
  expect(proxy(new NextRequest("https://example.test/")).status).toBe(200);
  expect(proxy(new NextRequest("https://example.test/health")).status).toBe(200);
});

it("limits a dedicated mobile gateway to the customer-scoped mobile API", () => {
  process.env.PARLANCE_MOBILE_GATEWAY_ONLY = "true";
  for (const path of ["/", "/api/parlance/customer/state", "/api/demo/mock-bank", "/api/operator/session", "/ops"])
    expect(proxy(new NextRequest(`https://example.test${path}`)).status).toBe(404);
  expect(proxy(new NextRequest("https://example.test/api/mobile/customer/state")).status).toBe(200);
});

it("lets the public safe mode take priority when both flags are set", () => {
  process.env.PARLANCE_MOBILE_GATEWAY_ONLY = "true";
  process.env.PARLANCE_PUBLIC_SAFE_MODE = "true";
  expect(proxy(new NextRequest("https://example.test/api/mobile/customer/state")).status).toBe(404);
});
