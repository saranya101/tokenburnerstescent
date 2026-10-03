import { OpsDashboard } from "./ops-dashboard";
import { parseOpsRuns, type OpsRun } from "../../lib/ops-read-model";

const apiUrl = process.env.API_URL ?? "http://127.0.0.1:4001";

async function loadRuns(): Promise<{ runs: OpsRun[]; error?: string }> {
  try {
    const response = await fetch(`${apiUrl}/v1/ops/runs`, { cache: "no-store" });
    if (!response.ok) return { runs: [], error: `Read model unavailable (${response.status})` };
    return { runs: parseOpsRuns(await response.json()) };
  } catch {
    return { runs: [], error: "The local API is unavailable." };
  }
}

export default async function OpsPage() {
  const { runs, error } = await loadRuns();
  return <OpsDashboard runs={runs} {...(error ? { error } : {})} />;
}
