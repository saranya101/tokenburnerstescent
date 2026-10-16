import { afterEach, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "./proxy";

const mobileRequired = ["PARLANCE_AUTH_JWT_SECRET", "DATABASE_URL", "DIRECT_URL", "PARLANCE_INTERNAL_API_TOKEN", "API_URL"];
afterEach(() => { for (const key of ["PARLANCE_PUBLIC_SAFE_MODE", "PARLANCE_PUBLIC_MOBILE_ENABLED", "PARLANCE_PUBLIC_WEB_ENABLED", "PARLANCE_MOBILE_GATEWAY_ONLY", ...mobileRequired]) delete process.env[key]; });

it("keeps development routes available when public safe mode is absent", () => {
  expect(proxy(new NextRequest("https://example.test/api/parlance/customer/state")).status).toBe(200);
});

it("blocks all banking, mobile, demo, and operator endpoints in public safe mode", () => {
  process.env.PARLANCE_PUBLIC_SAFE_MODE = "true";
  for (const path of ["/api", "/api/parlance/customer/state", "/api/parlance/messages", "/api/mobile/session/exchange", "/api/demo/mock-bank", "/api/operator/session", "/ops", "/execution/legacy-id", "/demo"]) {
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

it("permits only the configured authenticated mobile gateway while public safe mode remains enabled", () => {
  process.env.PARLANCE_PUBLIC_SAFE_MODE = "true";
  process.env.PARLANCE_PUBLIC_MOBILE_ENABLED = "true";
  for (const key of mobileRequired) process.env[key] = "configured";
  expect(proxy(new NextRequest("https://example.test/api/mobile/customer/state")).status).toBe(200);
  for (const path of ["/api/parlance/customer/state", "/api/operator/session", "/api/demo/mock-bank", "/ops"]) {
    expect(proxy(new NextRequest(`https://example.test${path}`)).status).toBe(404);
  }
  delete process.env.PARLANCE_AUTH_JWT_SECRET;
  expect(proxy(new NextRequest("https://example.test/api/mobile/customer/state")).status).toBe(404);
});

it("opens only the web sign-in and customer proxy when web mode is explicitly enabled", () => {
  process.env.PARLANCE_PUBLIC_SAFE_MODE = "true";
  process.env.PARLANCE_PUBLIC_WEB_ENABLED = "true";
  process.env.PARLANCE_PUBLIC_MOBILE_ENABLED = "true";
  for (const key of mobileRequired) process.env[key] = "configured";
  for (const path of ["/api/web-auth/login", "/api/web-auth/callback", "/api/web-auth/session", "/api/parlance/customer/state"])
    expect(proxy(new NextRequest(`https://example.test${path}`)).status).toBe(200);
  for (const path of ["/api/operator/session", "/api/demo/mock-bank", "/ops"])
    expect(proxy(new NextRequest(`https://example.test${path}`)).status).toBe(404);
});
