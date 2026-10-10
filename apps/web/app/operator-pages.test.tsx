import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import OpsPage from "./ops/page";
import DemoPage from "./demo/page";
import { createOperatorSession } from "../lib/server-api-auth";

const state = vi.hoisted(() => ({ cookie: undefined as string | undefined }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (name: string) => name === "parlance_operator_session" && state.cookie ? { value: state.cookie } : undefined }) }));

function configure() {
  process.env.PARLANCE_OPERATOR_ACCESS_TOKEN = "human-access-secret"; process.env.PARLANCE_OPS_API_TOKEN = "ops-service-secret";
  process.env.PARLANCE_OPERATOR_SESSION_SECRET = "session-signing-secret";
  process.env.PARLANCE_DEMO_MODE = "true"; process.env.PARLANCE_CUSTOMER_USER_ID = "demo-user"; process.env.PARLANCE_DEMO_USER_ID = "demo-user";
}

afterEach(() => { state.cookie = undefined; vi.unstubAllGlobals(); for (const key of ["PARLANCE_OPERATOR_ACCESS_TOKEN", "PARLANCE_OPERATOR_SESSION_SECRET", "PARLANCE_OPS_API_TOKEN", "PARLANCE_DEMO_MODE", "PARLANCE_CUSTOMER_USER_ID", "PARLANCE_DEMO_USER_ID"]) delete process.env[key]; });

describe("operator pages", () => {
  it("does not load ops data or demo controls without a session", async () => {
    configure(); const upstream = vi.fn(); vi.stubGlobal("fetch", upstream);
    expect(renderToStaticMarkup(await OpsPage())).toContain("Operator sign-in required");
    expect(renderToStaticMarkup(await DemoPage())).toContain("Demo controls unavailable"); expect(upstream).not.toHaveBeenCalled();
  });
  it("uses the server ops token only upstream after a valid session", async () => {
    configure(); state.cookie = createOperatorSession("human-access-secret")!;
    const upstream = vi.fn().mockResolvedValue(new Response(JSON.stringify([]), { status: 200 })); vi.stubGlobal("fetch", upstream);
    const html = renderToStaticMarkup(await OpsPage()); expect(upstream).toHaveBeenCalledWith(expect.stringContaining("/v1/ops/runs"), expect.objectContaining({ headers: { "x-parlance-ops-token": "ops-service-secret" } }));
    expect(html).not.toContain("ops-service-secret"); expect(html).not.toContain("human-access-secret");
    const demoHtml = renderToStaticMarkup(await DemoPage()); expect(demoHtml).toContain("Configured demo user"); expect(demoHtml).not.toContain("ops-service-secret");
  });
});
