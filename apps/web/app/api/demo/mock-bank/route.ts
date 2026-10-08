import { NextRequest, NextResponse } from "next/server";
import { isSupportedScenario, type DemoScenarioName } from "../../../../lib/demo-control";
import { bankApiHeaders, configuredDemoUserId, demoModeEnabled, OPERATOR_SESSION_COOKIE, operatorSessionValid, opsApiHeaders, sameOriginMutation } from "../../../../lib/server-api-auth";

const mockBankBaseUrl = (): string => (process.env.MOCK_BANK_URL?.trim() || "http://127.0.0.1:4002").replace(/\/$/, "");

class DemoDependencyError extends Error {
  constructor(readonly code: "MOCK_BANK_UNAVAILABLE" | "SCENARIO_REQUEST_REJECTED", readonly status: number) { super(code); }
}

async function mockBankRequest(path: string, privilege: "BANK" | "OPS", init?: RequestInit): Promise<unknown> {
  const authorization = privilege === "OPS" ? opsApiHeaders() : bankApiHeaders();
  if (!authorization) throw new DemoDependencyError("SCENARIO_REQUEST_REJECTED", 503);
  let response: Response;
  try {
    response = await fetch(`${mockBankBaseUrl()}${path}`, { ...init, cache: "no-store", headers: { ...init?.headers, ...authorization, "x-trace-id": `demo-${crypto.randomUUID()}` } });
  } catch {
    throw new DemoDependencyError("MOCK_BANK_UNAVAILABLE", 503);
  }
  if (!response.ok) throw new DemoDependencyError(init?.method === "POST" ? "SCENARIO_REQUEST_REJECTED" : "MOCK_BANK_UNAVAILABLE", init?.method === "POST" ? 502 : 503);
  try { return await response.json(); } catch { throw new DemoDependencyError("MOCK_BANK_UNAVAILABLE", 503); }
}

async function readState(userId: string): Promise<Record<string, unknown>> {
  const encodedUserId = encodeURIComponent(userId);
  const [snapshot, scenarioState] = await Promise.all([
    mockBankRequest(`/v1/state/${encodedUserId}`, "BANK"),
    mockBankRequest(`/v1/admin/scenarios/${encodedUserId}`, "OPS"),
  ]);
  if (!snapshot || typeof snapshot !== "object" || !scenarioState || typeof scenarioState !== "object" || !("scenarios" in scenarioState) || !Array.isArray(scenarioState.scenarios)) {
    throw new DemoDependencyError("MOCK_BANK_UNAVAILABLE", 503);
  }
  return { ...(snapshot as Record<string, unknown>), scenarios: scenarioState.scenarios };
}

function errorResponse(error: unknown): NextResponse {
  if (error instanceof DemoDependencyError) return NextResponse.json({ code: error.code }, { status: error.status });
  return NextResponse.json({ code: "MOCK_BANK_UNAVAILABLE" }, { status: 503 });
}

function authorize(request: NextRequest): NextResponse | undefined {
  if (!demoModeEnabled()) return NextResponse.json({ code: "NOT_FOUND" }, { status: 404 });
  if (!operatorSessionValid(request.cookies.get(OPERATOR_SESSION_COOKIE)?.value)) return NextResponse.json({ code: "REQUEST_NOT_AUTHORIZED" }, { status: 401 });
  return undefined;
}

export async function GET(request: NextRequest) {
  const rejected = authorize(request); if (rejected) return rejected;
  const configured = configuredDemoUserId();
  if (!configured) return NextResponse.json({ code: "SERVICE_UNAVAILABLE" }, { status: 503 });
  if (request.nextUrl.searchParams.has("userId") && request.nextUrl.searchParams.get("userId") !== configured) return NextResponse.json({ code: "NOT_FOUND" }, { status: 404 });
  try { return NextResponse.json(await readState(configured)); } catch (error) { return errorResponse(error); }
}

export async function POST(request: NextRequest) {
  const rejected = authorize(request); if (rejected) return rejected;
  if (!sameOriginMutation(request)) return NextResponse.json({ code: "REQUEST_NOT_AUTHORIZED" }, { status: 403 });
  const configured = configuredDemoUserId();
  if (!configured) return NextResponse.json({ code: "SERVICE_UNAVAILABLE" }, { status: 503 });
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ code: "SCENARIO_REQUEST_REJECTED" }, { status: 400 }); }
  if (!body || typeof body !== "object") return NextResponse.json({ code: "SCENARIO_REQUEST_REJECTED" }, { status: 400 });
  const requestedUserId = "userId" in body && typeof body.userId === "string" ? body.userId.trim() : undefined;
  const rawScenarios = "scenarios" in body ? body.scenarios : undefined;
  if (requestedUserId !== undefined && requestedUserId !== configured) return NextResponse.json({ code: "NOT_FOUND" }, { status: 404 });
  if (!Array.isArray(rawScenarios) || !rawScenarios.every(isSupportedScenario)) return NextResponse.json({ code: "UNSUPPORTED_SCENARIO" }, { status: 400 });
  const scenarios = rawScenarios as DemoScenarioName[];
  try {
    await mockBankRequest(`/v1/admin/scenarios/${encodeURIComponent(configured)}`, "OPS", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scenarios }) });
    return NextResponse.json(await readState(configured));
  } catch (error) { return errorResponse(error); }
}
