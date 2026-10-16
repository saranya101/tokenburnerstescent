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

it.each(["login", "signup"] as const)("submits %s directly to the shared password gateway without a provider token", async (mode) => {
  const tokens = { accessToken: "jwt".repeat(30), refreshToken: "r".repeat(43), accessExpiresAt: "2030-01-01T00:00:00.000Z", refreshExpiresAt: "2030-02-01T00:00:00.000Z" };
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(tokens), { status: 200 }));
  vi.stubGlobal("fetch", fetcher);
  expect(await mobileApi.passwordSession(mode, "anyone@gmail.com", "a-long-password")).toEqual(tokens);
  expect(fetcher).toHaveBeenCalledWith(`https://bank.example/api/mobile/session/${mode}`, expect.objectContaining({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "anyone@gmail.com", password: "a-long-password" }) }));
});
