import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "./route";
import { createOperatorSession, OPERATOR_SESSION_COOKIE } from "../../../../lib/server-api-auth";

const operatorHeaders = () => ({ cookie: `${OPERATOR_SESSION_COOKIE}=${createOperatorSession("human-test-token")}` });
const configure = () => {
  process.env.PARLANCE_DEMO_MODE = "true"; process.env.PARLANCE_OPS_API_TOKEN = "ops-test-token";
  process.env.PARLANCE_OPERATOR_ACCESS_TOKEN = "human-test-token"; process.env.PARLANCE_OPERATOR_SESSION_SECRET = "session-test-secret"; process.env.PARLANCE_BANK_API_TOKEN = "bank-test-token";
  process.env.PARLANCE_DEMO_USER_ID = "demo-user"; process.env.PARLANCE_CUSTOMER_USER_ID = "demo-user"; process.env.MOCK_BANK_URL = "http://mock-bank.internal:4002";
};

afterEach(() => {
  vi.unstubAllGlobals();
  for (const key of ["PARLANCE_DEMO_MODE", "PARLANCE_OPS_API_TOKEN", "PARLANCE_OPERATOR_ACCESS_TOKEN", "PARLANCE_OPERATOR_SESSION_SECRET", "PARLANCE_BANK_API_TOKEN", "PARLANCE_DEMO_USER_ID", "PARLANCE_CUSTOMER_USER_ID", "MOCK_BANK_URL"]) delete process.env[key];
});

describe("demo mock-bank BFF", () => {
  it("rejects missing and customer-only credentials", async () => {
    configure(); const upstream = vi.fn(); vi.stubGlobal("fetch", upstream);
    expect((await GET(new NextRequest("http://localhost/api/demo/mock-bank"))).status).toBe(401);
    expect((await GET(new NextRequest("http://localhost/api/demo/mock-bank", { headers: { "x-parlance-internal-token": "customer" } }))).status).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("rejects an authorized operator while demo mode is disabled", async () => {
    configure(); process.env.PARLANCE_DEMO_MODE = "false"; const upstream = vi.fn(); vi.stubGlobal("fetch", upstream);
    expect((await GET(new NextRequest("http://localhost/api/demo/mock-bank", { headers: operatorHeaders() }))).status).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("allows the configured operator and injects the server-side ops credential", async () => {
    configure(); const snapshot = { userId: "demo-user" }; const scenarios = { scenarios: [] };
    const upstream = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(snapshot), { status: 200 })).mockResolvedValueOnce(new Response(JSON.stringify(scenarios), { status: 200 })); vi.stubGlobal("fetch", upstream);
    const response = await GET(new NextRequest("http://localhost/api/demo/mock-bank", { headers: operatorHeaders() }));
    expect(response.status).toBe(200); expect(upstream).toHaveBeenCalledTimes(2);
    expect((upstream.mock.calls[0]?.[1] as RequestInit).headers).toEqual(expect.objectContaining({ "x-parlance-bank-token": "bank-test-token" }));
    expect((upstream.mock.calls[1]?.[1] as RequestInit).headers).toEqual(expect.objectContaining({ "x-parlance-ops-token": "ops-test-token" }));
  });

  it("does not allow an operator to select another user", async () => {
    configure(); const upstream = vi.fn(); vi.stubGlobal("fetch", upstream);
    const get = await GET(new NextRequest("http://localhost/api/demo/mock-bank?userId=other-user", { headers: operatorHeaders() }));
    const post = await POST(new NextRequest("http://localhost/api/demo/mock-bank", { method: "POST", headers: { ...operatorHeaders(), origin: "http://localhost", "content-type": "application/json" }, body: JSON.stringify({ userId: "other-user", scenarios: [] }) }));
    expect(get.status).toBe(404); expect(post.status).toBe(404); expect(upstream).not.toHaveBeenCalled();
  });

  it("rejects cross-origin demo mutations", async () => {
    configure(); const upstream = vi.fn(); vi.stubGlobal("fetch", upstream);
    const response = await POST(new NextRequest("http://localhost/api/demo/mock-bank", { method: "POST", headers: { ...operatorHeaders(), origin: "https://evil.example", "content-type": "application/json" }, body: JSON.stringify({ scenarios: [] }) }));
    expect(response.status).toBe(403); expect(upstream).not.toHaveBeenCalled();
  });
});
