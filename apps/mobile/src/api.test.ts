import { afterEach, expect, it, vi } from "vitest";

vi.mock("expo-constants", () => ({ default: { expoConfig: { extra: {
  apiBaseUrl: "https://bank.example", oidcIssuer: "https://identity.example", oidcClientId: "native-client",
} } } }));

import { mobileApi } from "./api";

afterEach(() => vi.unstubAllGlobals());

it("uses only the mobile HTTPS gateway and the customer's opaque session token", async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ authenticated: true, userId: "alice" }), { status: 200 }));
  vi.stubGlobal("fetch", fetcher);
  await expect(mobileApi.session("opaque-access-token")).resolves.toEqual({ authenticated: true, userId: "alice" });
  expect(fetcher).toHaveBeenCalledWith("https://bank.example/api/mobile/session", expect.objectContaining({
    method: "GET", headers: { authorization: "Bearer opaque-access-token" },
  }));
});

it("rejects malformed execution status instead of showing a false empty history", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ unexpected: [] }), { status: 200 })));
  await expect(mobileApi.operations("opaque-access-token")).rejects.toThrow();
});
