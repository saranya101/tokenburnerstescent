import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it } from "vitest";
import { DELETE, POST } from "./route";
import { bankApiHeaders, configuredDemoUserId, createOperatorSession, customerApiHeaders, OPERATOR_SESSION_COOKIE, operatorSessionValid, opsApiHeaders } from "../../../../lib/server-api-auth";

const secretKeys = ["PARLANCE_INTERNAL_API_TOKEN", "PARLANCE_OPS_API_TOKEN", "PARLANCE_OPERATOR_ACCESS_TOKEN", "PARLANCE_OPERATOR_SESSION_SECRET", "PARLANCE_BANK_API_TOKEN"] as const;
afterEach(() => { for (const key of [...secretKeys, "PARLANCE_CUSTOMER_USER_ID", "PARLANCE_DEMO_USER_ID"]) delete process.env[key]; });
const request = (accessToken: string) => new NextRequest("http://localhost/api/operator/session", { method: "POST", headers: { origin: "http://localhost", "content-type": "application/json" }, body: JSON.stringify({ accessToken }) });
const signSession = (secret: string, issuedAt: number, expiresAt: number) => { const payload = `v1.${issuedAt}.${expiresAt}`; return `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`; };
const configure = () => {
  process.env.PARLANCE_INTERNAL_API_TOKEN = "internal-secret"; process.env.PARLANCE_OPS_API_TOKEN = "ops-service-secret";
  process.env.PARLANCE_OPERATOR_ACCESS_TOKEN = "human-secret"; process.env.PARLANCE_OPERATOR_SESSION_SECRET = "session-signing-secret";
  process.env.PARLANCE_BANK_API_TOKEN = "bank-service-secret"; process.env.PARLANCE_CUSTOMER_USER_ID = "demo-user";
};

describe("operator session", () => {
  it("rejects a wrong human access token", async () => { configure(); expect((await POST(request("wrong"))).status).toBe(401); });
  it("sets a signed HttpOnly session containing neither service nor human secret", async () => {
    configure();
    const response = await POST(request("human-secret")); const cookie = response.headers.get("set-cookie") ?? "";
    expect(response.status).toBe(200); expect(cookie).toContain(`${OPERATOR_SESSION_COOKIE}=`); expect(cookie).toContain("HttpOnly"); expect(cookie).toContain("SameSite=strict");
    for (const secret of secretKeys.map((key) => process.env[key]!)) expect(cookie).not.toContain(secret);
  });
  it("accepts a normal session and rejects expired and tampered sessions", () => {
    configure(); const now = Date.now(); const session = createOperatorSession("human-secret", now)!;
    expect(operatorSessionValid(session, now)).toBe(true); expect(operatorSessionValid(`${session}x`, now)).toBe(false); expect(operatorSessionValid(session, now + 16 * 60_000)).toBe(false);
  });
  it("rejects correctly signed excessive-lifetime and future-issued sessions", () => {
    configure(); const now = Math.floor(Date.now() / 1000);
    expect(operatorSessionValid(signSession("session-signing-secret", now, now + 901), now * 1000)).toBe(false);
    expect(operatorSessionValid(signSession("session-signing-secret", now + 31, now + 900), now * 1000)).toBe(false);
  });
  it("does not accept a session signed with the human access credential", () => {
    configure(); const now = Math.floor(Date.now() / 1000);
    expect(operatorSessionValid(signSession("human-secret", now, now + 900), now * 1000)).toBe(false);
  });
  it("fails closed when credentials collide and accepts five unique credentials", async () => {
    configure(); expect((await POST(request("human-secret"))).status).toBe(200);
    process.env.PARLANCE_OPERATOR_ACCESS_TOKEN = "ops-service-secret"; expect((await POST(request("ops-service-secret"))).status).toBe(401);
    configure(); process.env.PARLANCE_INTERNAL_API_TOKEN = "bank-service-secret"; expect(customerApiHeaders()).toBeUndefined(); expect(bankApiHeaders()).toBeUndefined();
    configure(); process.env.PARLANCE_OPS_API_TOKEN = "bank-service-secret"; expect(opsApiHeaders()).toBeUndefined(); expect(bankApiHeaders()).toBeUndefined();
    configure(); process.env.PARLANCE_OPERATOR_SESSION_SECRET = "human-secret"; expect((await POST(request("human-secret"))).status).toBe(401);
  });
  it("clears the session on logout", async () => { const response = await DELETE(new NextRequest("http://localhost/api/operator/session", { method: "DELETE", headers: { origin: "http://localhost" } })); expect(response.headers.get("set-cookie")).toContain("Max-Age=0"); });
  it("fails closed when fixed customer and demo identities differ", () => { process.env.PARLANCE_CUSTOMER_USER_ID = "user-a"; process.env.PARLANCE_DEMO_USER_ID = "user-b"; expect(configuredDemoUserId()).toBeUndefined(); });
});
