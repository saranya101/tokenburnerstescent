export const SUPPORTED_SCENARIOS = [
  "ASSET_UNAVAILABLE",
  "BALANCE_CHANGED",
  "FX_UNAVAILABLE",
  "TRANSFER_RAIL_UNAVAILABLE",
  "QUOTE_EXPIRED",
] as const;

export type DemoScenarioName = (typeof SUPPORTED_SCENARIOS)[number];

export type DemoBankState = {
  userId: string;
  stateVersion: number;
  capturedAt: string;
  accounts: Array<{
    id: string;
    type: string;
    currency: string;
    availableMinorUnits: string;
    ledgerMinorUnits: string;
    status: string;
  }>;
  assets: Array<{
    id: string;
    symbol: string;
    name: string;
    tradable: boolean;
    settlementCurrency: string;
  }>;
  serviceAvailability: Record<string, boolean>;
  fxQuotes: Array<{
    id: string;
    fromCurrency: string;
    toCurrency: string;
    rate: string;
    expiresAt: string;
  }>;
  scenarios: DemoScenarioName[];
};

export const SCENARIO_DETAILS: Record<DemoScenarioName, { name: string; explanation: string }> = {
  ASSET_UNAVAILABLE: { name: "Asset unavailable", explanation: "Makes mock investment execution unavailable for the targeted user." },
  BALANCE_CHANGED: { name: "Balance changed", explanation: "Forces execution to observe a changed mock-bank state." },
  FX_UNAVAILABLE: { name: "FX service unavailable", explanation: "Makes the mock foreign-exchange service unavailable." },
  TRANSFER_RAIL_UNAVAILABLE: { name: "Transfer rail unavailable", explanation: "Makes mock transfers and bill payments unavailable." },
  QUOTE_EXPIRED: { name: "Quote expired", explanation: "Makes the mock bank reject FX execution because its quote expired." },
};

export const DEMO_PRESETS: Array<{ id: string; title: string; purpose: string; scenario: DemoScenarioName }> = [
  { id: "apple-unavailable", title: "Apple becomes unavailable", purpose: "Show goal preservation before an approved FX → buy route can begin.", scenario: "ASSET_UNAVAILABLE" },
  { id: "balance-change", title: "Balance changes before execution", purpose: "Show state-version drift and deterministic revalidation.", scenario: "BALANCE_CHANGED" },
  { id: "fx-unavailable", title: "FX service unavailable", purpose: "Show safe pause and zero-write behavior.", scenario: "FX_UNAVAILABLE" },
  { id: "quote-expired", title: "Quote expires", purpose: "Show stale financial-state protection.", scenario: "QUOTE_EXPIRED" },
];

export function isSupportedScenario(value: unknown): value is DemoScenarioName {
  return typeof value === "string" && SUPPORTED_SCENARIOS.includes(value as DemoScenarioName);
}

export function isValidDemoUserId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

export function buildScenarioRequest(userId: string, scenarios: readonly DemoScenarioName[]): { url: string; init: RequestInit } {
  if (!isValidDemoUserId(userId)) throw new Error("INVALID_USER_ID");
  if (!scenarios.every(isSupportedScenario)) throw new Error("UNSUPPORTED_SCENARIO");
  return {
    url: "/api/demo/mock-bank",
    init: {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId, scenarios }),
    },
  };
}

async function responseBody(response: Response): Promise<unknown> {
  try { return await response.json(); } catch { return undefined; }
}

export async function fetchDemoBankState(userId: string, fetcher: typeof fetch = fetch): Promise<DemoBankState> {
  if (!isValidDemoUserId(userId)) throw new Error("INVALID_USER_ID");
  const response = await fetcher(`/api/demo/mock-bank?userId=${encodeURIComponent(userId)}`, { cache: "no-store" });
  const body = await responseBody(response);
  if (!response.ok) throw new Error(typeof body === "object" && body && "code" in body ? String(body.code) : "MOCK_BANK_UNAVAILABLE");
  return body as DemoBankState;
}

export async function updateDemoScenarios(userId: string, scenarios: readonly DemoScenarioName[], fetcher: typeof fetch = fetch): Promise<DemoBankState> {
  const request = buildScenarioRequest(userId, scenarios);
  const response = await fetcher(request.url, request.init);
  const body = await responseBody(response);
  if (!response.ok) throw new Error(typeof body === "object" && body && "code" in body ? String(body.code) : "SCENARIO_REQUEST_REJECTED");
  return body as DemoBankState;
}
