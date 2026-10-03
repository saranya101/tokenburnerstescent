import { NextRequest, NextResponse } from "next/server";
import { isSupportedScenario, isValidDemoUserId, type DemoScenarioName } from "../../../../lib/demo-control";

const mockBankBaseUrl = (): string => (process.env.MOCK_BANK_URL?.trim() || "http://127.0.0.1:4002").replace(/\/$/, "");

class DemoDependencyError extends Error {
  constructor(readonly code: "MOCK_BANK_UNAVAILABLE" | "SCENARIO_REQUEST_REJECTED", readonly status: number) { super(code); }
}

async function mockBankRequest(path: string, init?: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${mockBankBaseUrl()}${path}`, { ...init, cache: "no-store", headers: { ...init?.headers, "x-trace-id": `demo-${crypto.randomUUID()}` } });
  } catch {
    throw new DemoDependencyError("MOCK_BANK_UNAVAILABLE", 503);
  }
  if (!response.ok) throw new DemoDependencyError(init?.method === "POST" ? "SCENARIO_REQUEST_REJECTED" : "MOCK_BANK_UNAVAILABLE", init?.method === "POST" ? 502 : 503);
  try { return await response.json(); } catch { throw new DemoDependencyError("MOCK_BANK_UNAVAILABLE", 503); }
}

async function readState(userId: string): Promise<Record<string, unknown>> {
  const encodedUserId = encodeURIComponent(userId);
  const [snapshot, scenarioState] = await Promise.all([
    mockBankRequest(`/v1/state/${encodedUserId}`),
    mockBankRequest(`/v1/admin/scenarios/${encodedUserId}`),
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

export async function GET(request: NextRequest) {
  const userId = request.nextUrl.searchParams.get("userId")?.trim() ?? "";
  if (!isValidDemoUserId(userId)) return NextResponse.json({ code: "INVALID_USER_ID" }, { status: 400 });
  try { return NextResponse.json(await readState(userId)); } catch (error) { return errorResponse(error); }
}

export async function POST(request: NextRequest) {
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ code: "SCENARIO_REQUEST_REJECTED" }, { status: 400 }); }
  if (!body || typeof body !== "object") return NextResponse.json({ code: "SCENARIO_REQUEST_REJECTED" }, { status: 400 });
  const userId = "userId" in body && typeof body.userId === "string" ? body.userId.trim() : "";
  const rawScenarios = "scenarios" in body ? body.scenarios : undefined;
  if (!isValidDemoUserId(userId)) return NextResponse.json({ code: "INVALID_USER_ID" }, { status: 400 });
  if (!Array.isArray(rawScenarios) || !rawScenarios.every(isSupportedScenario)) return NextResponse.json({ code: "UNSUPPORTED_SCENARIO" }, { status: 400 });
  const scenarios = rawScenarios as DemoScenarioName[];
  try {
    await mockBankRequest(`/v1/admin/scenarios/${encodeURIComponent(userId)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scenarios }) });
    return NextResponse.json(await readState(userId));
  } catch (error) { return errorResponse(error); }
}
