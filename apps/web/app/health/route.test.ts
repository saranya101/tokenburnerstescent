import { afterEach, expect, it, vi } from "vitest";
import { GET } from "./route";

afterEach(() => { vi.unstubAllGlobals(); delete process.env.PARLANCE_PUBLIC_SAFE_MODE; delete process.env.PARLANCE_PUBLIC_WEB_ENABLED; delete process.env.API_URL; });

it("reports internal backend readiness without exposing its URL", async () => {
  process.env.PARLANCE_PUBLIC_SAFE_MODE = "true";
  process.env.API_URL = "http://127.0.0.1:4001";
  const upstream = vi.fn(async () => new Response(null, { status: 200 }));
  vi.stubGlobal("fetch", upstream);
  const response = await GET();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: "ok", mode: "interface-preview", backend: "ready" });
  expect(upstream).toHaveBeenCalledWith("http://127.0.0.1:4001/ready", expect.objectContaining({ cache: "no-store" }));
});

it("requires backend readiness when the authenticated web gateway is enabled", async () => {
  process.env.PARLANCE_PUBLIC_SAFE_MODE = "true";
  process.env.PARLANCE_PUBLIC_WEB_ENABLED = "true";
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 503 })));
  const response = await GET();
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ status: "not_ready", mode: "authenticated-gateway", backend: "unavailable" });
});

it("keeps preview available but blocks application readiness when the backend fails", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 503 })));
  process.env.PARLANCE_PUBLIC_SAFE_MODE = "true";
  expect((await GET()).status).toBe(200);
  process.env.PARLANCE_PUBLIC_SAFE_MODE = "false";
  const response = await GET();
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ status: "not_ready", mode: "application", backend: "unavailable" });
});
