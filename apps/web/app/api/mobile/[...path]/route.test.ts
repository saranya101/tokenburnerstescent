import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const identity = vi.hoisted(() => ({ userId: undefined as string | undefined, oidcUserId: undefined as string | undefined }));
vi.mock("../../../../lib/mobile-auth", () => ({
  mobileSessionCustomer: vi.fn(async () => identity.userId),
  verifiedMobileIdentity: vi.fn(async () => identity.oidcUserId ? { userId: identity.oidcUserId, issuer: "https://identity.example", subject: "sub" } : undefined),
  createMobileSession: vi.fn(async () => ({ accessToken: "access", refreshToken: "refresh", accessExpiresAt: "2030-01-01T00:00:00.000Z", refreshExpiresAt: "2030-02-01T00:00:00.000Z" })),
  rotateMobileSession: vi.fn(async () => undefined), revokeMobileSession: vi.fn(async () => undefined),
}));
import { GET, POST } from "./route";
import { GET as WEB_GET } from "../../parlance/[...path]/route";

const context = (...path: string[]) => ({ params: Promise.resolve({ path }) });
beforeEach(() => {
  identity.userId = undefined;
  identity.oidcUserId = undefined;
  process.env.PARLANCE_INTERNAL_API_TOKEN = "server-only-customer-token";
  process.env.PARLANCE_OPS_API_TOKEN = "separate-operator-token";
  process.env.PARLANCE_BANK_API_TOKEN = "separate-bank-token";
});

describe("mobile customer gateway", () => {
  it("rejects unauthenticated state reads", async () => {
    const request = new NextRequest("https://bank.example/api/mobile/customer/state");
    expect((await GET(request, context("customer", "state"))).status).toBe(401);
  });
  it("exchanges only verified external identity for a mobile session", async () => {
    const request = new NextRequest("https://bank.example/api/mobile/session/exchange", { method: "POST", headers: { authorization: "Bearer external-jwt" }, body: "{}" });
    expect((await POST(request, context("session", "exchange"))).status).toBe(401);
    identity.oidcUserId = "alice";
    const response = await POST(request, context("session", "exchange"));
    expect(response.status).toBe(200);
    expect((await response.json()).accessToken).toBe("access");
  });
  it("does not forward authorization or execution routes", async () => {
    identity.userId = "alice";
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    const approve = new NextRequest("https://bank.example/api/mobile/plans/p1/approval-options", { method: "POST", body: "{}" });
    const execute = new NextRequest("https://bank.example/api/mobile/executions/e1/run", { method: "POST", body: "{}" });
    expect((await POST(approve, context("plans", "p1", "approval-options"))).status).toBe(404);
    expect((await POST(execute, context("executions", "e1", "run"))).status).toBe(404);
    expect(fetcher).not.toHaveBeenCalled(); fetcher.mockRestore();
  });
  it("injects the verified customer rather than caller headers", async () => {
    identity.userId = "alice";
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
    const request = new NextRequest("https://bank.example/api/mobile/customer/operations", { headers: { authorization: "Bearer opaque", "x-parlance-customer-id": "bob", "x-parlance-internal-token": "attacker" } });
    expect((await GET(request, context("customer", "operations"))).status).toBe(200);
    const forwarded = fetcher.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(forwarded["x-parlance-customer-id"]).toBe("alice");
    expect(forwarded["x-parlance-internal-token"]).toBe("server-only-customer-token");
    fetcher.mockRestore();
  });
  it("returns the same changing customer state to web and mobile in an isolated read simulation", async () => {
    identity.userId = "alice";
    process.env.PARLANCE_CUSTOMER_USER_ID = "alice";
    process.env.API_URL = "http://isolated-api.local";
    let version = 7;
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, options) => {
      const headers = options?.headers as Record<string, string>;
      if (headers["x-parlance-customer-id"] !== "alice") return new Response(JSON.stringify({ code: "FORBIDDEN" }), { status: 403 });
      return new Response(JSON.stringify({ userId: "alice", stateVersion: version,
        accounts: [{ id: "acc-sgd", availableMinorUnits: version === 7 ? "2000000" : "1990000" }],
        holdings: [{ assetId: "asset-aapl", quantity: "1" }],
        beneficiaries: [{ id: "ben-john-lim", name: "John Lim" }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    for (const expectedVersion of [7, 8]) {
      version = expectedVersion;
      const web = await WEB_GET(new NextRequest("http://localhost/api/parlance/customer/state"), context("customer", "state"));
      const mobile = await GET(new NextRequest("https://bank.example/api/mobile/customer/state", { headers: { authorization: "Bearer opaque" } }), context("customer", "state"));
      expect(web.status).toBe(200); expect(mobile.status).toBe(200);
      expect(await mobile.json()).toEqual(await web.json());
    }
    expect(fetcher).toHaveBeenCalledTimes(4);
    fetcher.mockRestore();
    delete process.env.PARLANCE_CUSTOMER_USER_ID;
    delete process.env.API_URL;
  });
});
