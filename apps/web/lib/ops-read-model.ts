export type OpsStageState = "COMPLETE" | "WAITING" | "STOPPED" | "FAILED" | "NOT_REACHED";

export interface OpsStage {
  state: OpsStageState;
  summary: string;
  detail?: Record<string, unknown>;
}

export interface OpsAuditEvent {
  id: string;
  eventType: string;
  occurredAt: string;
  aggregateType: string;
  aggregateId: string;
  traceId: string;
  metadata: unknown;
}

export interface OpsRun {
  id: string;
  occurredAt: string;
  headline: string;
  overallState: string;
  stages: {
    request: OpsStage;
    interpretation: OpsStage;
    semanticValidation: OpsStage;
    confirmedGoal: OpsStage;
    plan: OpsStage;
    authorization: OpsStage;
    execution: OpsStage;
    bankResult: OpsStage;
  };
  audit: OpsAuditEvent[];
}

const stageStates = new Set<OpsStageState>(["COMPLETE", "WAITING", "STOPPED", "FAILED", "NOT_REACHED"]);
const stageKeys = ["request", "interpretation", "semanticValidation", "confirmedGoal", "plan", "authorization", "execution", "bankResult"] as const;

export function parseOpsRuns(value: unknown): OpsRun[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isOpsRun).map((run) => ({ ...run, audit: [...run.audit].sort((left, right) => Date.parse(left.occurredAt) - Date.parse(right.occurredAt)) }));
}

function isOpsRun(value: unknown): value is OpsRun {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.occurredAt !== "string" || typeof value.headline !== "string" || typeof value.overallState !== "string" || !isRecord(value.stages) || !Array.isArray(value.audit)) return false;
  const runStages = value.stages;
  return stageKeys.every((key) => isStage(runStages[key])) && value.audit.every(isAudit);
}

function isStage(value: unknown): value is OpsStage {
  return isRecord(value) && typeof value.state === "string" && stageStates.has(value.state as OpsStageState) && typeof value.summary === "string" && (value.detail === undefined || isRecord(value.detail));
}

function isAudit(value: unknown): value is OpsAuditEvent {
  return isRecord(value) && ["id", "eventType", "occurredAt", "aggregateType", "aggregateId", "traceId"].every((key) => typeof value[key] === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

const forbiddenKey = /(authorization|credential|public.?key|signature|challenge(?!status)|cookie|session|bearer|token|secret|api.?key|prompt|provider|attestation|client.?data|authenticator.?data|raw.?response)/i;

export function redactForDisplay(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return /^(bearer\s+|sk-[a-z0-9_-]{8,}|eyJ[a-z0-9_-]+\.[a-z0-9_-]+\.)/i.test(value) ? "[redacted]" : value;
  if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value !== "object") return "[redacted]";
  if (seen.has(value)) return "[redacted circular value]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redactForDisplay(item, seen));
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) output[key] = forbiddenKey.test(key) ? "[redacted]" : redactForDisplay(child, seen);
  return output;
}
