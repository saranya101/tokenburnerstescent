import { OpsDashboard } from "./ops-dashboard";
import { parseOpsRuns, type OpsRun } from "../../lib/ops-read-model";
import { cookies } from "next/headers";
import { apiBaseUrl, OPERATOR_SESSION_COOKIE, operatorSessionValid, opsApiHeaders, webSecurityConfigurationValid } from "../../lib/server-api-auth";

async function loadRuns(): Promise<{ runs: OpsRun[]; error?: string }> {
  const authorization = opsApiHeaders();
  if (!authorization) return { runs: [], error: "Operator access is not configured." };
  try {
    const response = await fetch(`${apiBaseUrl()}/v1/ops/runs`, { cache: "no-store", headers: authorization });
    if (!response.ok) return { runs: [], error: `Read model unavailable (${response.status})` };
    return { runs: parseOpsRuns(await response.json()) };
  } catch {
    return { runs: [], error: "The local API is unavailable." };
  }
}

export default async function OpsPage() {
  const environment = environmentLabel();
  const accessConfigured = Boolean(process.env.PARLANCE_OPERATOR_ACCESS_TOKEN?.trim() && process.env.PARLANCE_OPERATOR_SESSION_SECRET?.trim() && process.env.PARLANCE_OPS_API_TOKEN?.trim() && webSecurityConfigurationValid());
  if (!operatorSessionValid((await cookies()).get(OPERATOR_SESSION_COOKIE)?.value)) return <OpsDashboard runs={[]} accessState={accessConfigured ? "required" : "unconfigured"} environment={environment} />;
  const { runs, error } = await loadRuns();
  return <OpsDashboard runs={runs} accessState="authenticated" environment={environment} {...(error ? { error } : {})} />;
}

function environmentLabel(): string {
  const test = process.env.TEST_DATABASE_URL?.trim();
  const database = process.env.DATABASE_URL?.trim();
  const direct = process.env.DIRECT_URL?.trim();
  if (test && database === test && direct === test) return "LOCAL TEST";
  return process.env.NODE_ENV === "development" ? "LOCAL · UNVERIFIED" : "ENVIRONMENT UNVERIFIED";
}
