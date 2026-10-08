import { OpsDashboard } from "./ops-dashboard";
import { parseOpsRuns, type OpsRun } from "../../lib/ops-read-model";
import { cookies } from "next/headers";
import { apiBaseUrl, OPERATOR_SESSION_COOKIE, operatorSessionValid, opsApiHeaders } from "../../lib/server-api-auth";

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
  if (!operatorSessionValid((await cookies()).get(OPERATOR_SESSION_COOKIE)?.value)) return <OpsDashboard runs={[]} error="Operator login is required." />;
  const { runs, error } = await loadRuns();
  return <OpsDashboard runs={runs} {...(error ? { error } : {})} />;
}
