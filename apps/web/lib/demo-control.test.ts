import { describe, expect, it, vi } from "vitest";
import { customerDesktopNavigation, customerMobileNavigation } from "../components/banking/banking-nav";
import {
  buildScenarioRequest,
  fetchDemoBankState,
  updateDemoScenarios,
  type DemoBankState,
  type DemoScenarioName,
} from "./demo-control";

const state: DemoBankState = {
  userId: "user-1",
  stateVersion: 7,
  capturedAt: "2026-09-22T00:00:00.000Z",
  accounts: [],
  assets: [],
  serviceAvailability: { transfers: true, fx: true, billPayments: true, investments: true },
  fxQuotes: [],
  scenarios: ["ASSET_UNAVAILABLE"],
};

const response = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

describe("demo control", () => {
  it("does not appear in customer navigation", () => {
    expect([...customerDesktopNavigation, ...customerMobileNavigation].some((item) => item.href === "/demo")).toBe(false);
  });

  it("generates the exact supported mock-bank scenario request", () => {
    expect(buildScenarioRequest("user-1", ["ASSET_UNAVAILABLE"])).toEqual({
      url: "/api/demo/mock-bank",
      init: { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ userId: "user-1", scenarios: ["ASSET_UNAVAILABLE"] }) },
    });
  });

  it("reset submits an empty scenario set and uses the refreshed response", async () => {
    const resetState = { ...state, scenarios: [] };
    const fetcher = vi.fn(() => response(resetState)) as unknown as typeof fetch;
    await expect(updateDemoScenarios("user-1", [], fetcher)).resolves.toEqual(resetState);
    expect(JSON.parse(String((fetcher as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.body))).toEqual({ userId: "user-1", scenarios: [] });
  });

  it("returns the refreshed mock-bank state", async () => {
    const fetcher = vi.fn(() => response(state)) as unknown as typeof fetch;
    await expect(fetchDemoBankState("user-1", fetcher)).resolves.toEqual(state);
    expect(fetcher).toHaveBeenCalledWith("/api/demo/mock-bank?userId=user-1", { cache: "no-store" });
  });

  it("cannot submit unsupported scenario names", () => {
    expect(() => buildScenarioRequest("user-1", ["NOT_A_SCENARIO" as DemoScenarioName])).toThrow("UNSUPPORTED_SCENARIO");
  });
});
