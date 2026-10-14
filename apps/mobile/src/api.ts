import Constants from "expo-constants";
import { z } from "zod";
import { BankStateSnapshotV1, CustomerActivityV1, CompilerResultV1, FinancialPlanV1, GoalContractV1, GoalBundleContractV1 } from "@parlance/contracts";

export const publicConfig = {
  apiBaseUrl: String(Constants.expoConfig?.extra?.apiBaseUrl ?? "").replace(/\/$/u, ""),
  oidcIssuer: String(Constants.expoConfig?.extra?.oidcIssuer ?? ""),
  oidcClientId: String(Constants.expoConfig?.extra?.oidcClientId ?? ""),
  oidcAudience: String(Constants.expoConfig?.extra?.oidcAudience ?? ""),
};

export type BankState = BankStateSnapshotV1;
export type Activity = CustomerActivityV1;
export type Operation = { executionId: string; planId: string; status: string; createdAt: string; updatedAt: string; finalStateVersion?: number; steps: Array<{ action: string; status: string; bankReference?: string; errorCode?: string }> };
export type Clarification = { reason: string; field: string; originalReference: string; questionKey: string; options: Array<{ entityId: string; entityType: string; displayName: string; currency?: string }> };
export type Interpretation =
  | { status: "NEEDS_CLARIFICATION"; clarificationId: string; clarifications: Clarification[] }
  | { status: "NEEDS_BUNDLE_CLARIFICATION"; clarificationId: string; clarifications: Clarification[] }
  | { status: "AWAITING_GOAL_CONFIRMATION"; candidateId: string; goalCandidate: unknown }
  | { status: "AWAITING_BUNDLE_CONFIRMATION"; candidateId: string; goalBundleCandidate: unknown }
  | { status: "SEMANTIC_VALIDATION_FAILED"; message: string };
export type Review = { kind: "GOAL" | "BUNDLE"; id: string; plan: FinancialPlanV1; subject: GoalContractV1 | GoalBundleContractV1 };
export type Journey = { id: string; updatedAt: string; request: string; flow:
  | { phase: "CLARIFY"; data: Extract<Interpretation, { clarificationId: string }> }
  | { phase: "MEANING"; data: Extract<Interpretation, { candidateId: string }> }
  | { phase: "PLAN"; review: Review } };

export class ApiError extends Error { constructor(readonly code: string, readonly status: number) { super(code); } }
export const MobileTokens = z.object({ accessToken: z.string().min(40), refreshToken: z.string().min(40), accessExpiresAt: z.iso.datetime(), refreshExpiresAt: z.iso.datetime() });
export type MobileTokens = z.infer<typeof MobileTokens>;
const CustomerSession = z.object({ authenticated: z.literal(true), userId: z.string().min(1) });
const OperationRecord = z.object({
  executionId: z.string().min(1), planId: z.string().min(1), status: z.string().min(1),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(), finalStateVersion: z.number().int().optional(),
  steps: z.array(z.object({ action: z.string().min(1), status: z.string().min(1), bankReference: z.string().optional(), errorCode: z.string().optional() })),
});

async function sessionPost(path: string, body: unknown, authorization?: string): Promise<unknown> {
  if (!publicConfig.apiBaseUrl.startsWith("https://")) throw new ApiError("SECURE_API_NOT_CONFIGURED", 0);
  const response = await fetch(`${publicConfig.apiBaseUrl}/api/mobile/session/${path}`, { method: "POST", cache: "no-store", headers: {
    "content-type": "application/json", ...(authorization ? { authorization: `Bearer ${authorization}` } : {}),
  }, body: JSON.stringify(body) });
  if (response.status === 204) return undefined;
  let value: any; try { value = await response.json(); } catch { throw new ApiError("INVALID_API_RESPONSE", response.status); }
  if (!response.ok) throw new ApiError(typeof value?.code === "string" ? value.code : "REQUEST_FAILED", response.status);
  return value;
}

async function request(token: string, path: string, body?: unknown): Promise<unknown> {
  if (!publicConfig.apiBaseUrl.startsWith("https://")) throw new ApiError("SECURE_API_NOT_CONFIGURED", 0);
  const response = await fetch(`${publicConfig.apiBaseUrl}/api/mobile/${path}`, {
    method: body === undefined ? "GET" : "POST", cache: "no-store",
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let value: any;
  try { value = await response.json(); } catch { throw new ApiError("INVALID_API_RESPONSE", response.status); }
  if (!response.ok) throw new ApiError(typeof value?.code === "string" ? value.code : "REQUEST_FAILED", response.status);
  return value;
}

export const mobileApi = {
  exchange: async (oidcAccessToken: string) => MobileTokens.parse(await sessionPost("exchange", {}, oidcAccessToken)),
  refreshSession: async (refreshToken: string) => MobileTokens.parse(await sessionPost("refresh", { refreshToken })),
  revokeSession: async (refreshToken: string) => { await sessionPost("logout", { refreshToken }); },
  session: async (token: string) => CustomerSession.parse(await request(token, "session")),
  state: async (token: string) => BankStateSnapshotV1.parse(await request(token, "customer/state")),
  activity: async (token: string) => CustomerActivityV1.parse(await request(token, "customer/activity")),
  operations: async (token: string): Promise<Operation[]> => z.object({ items: z.array(OperationRecord) }).parse(await request(token, "customer/operations")).items,
  journeys: async (token: string): Promise<Journey[]> => {
    const value = await request(token, "customer/journeys") as { items?: Journey[] };
    if (!Array.isArray(value.items)) throw new ApiError("INVALID_API_RESPONSE", 502);
    return value.items.map((item) => {
      if (item.flow?.phase === "PLAN") {
        item.flow.review.plan = FinancialPlanV1.parse(item.flow.review.plan);
        item.flow.review.subject = item.flow.review.kind === "BUNDLE" ? GoalBundleContractV1.parse(item.flow.review.subject) : GoalContractV1.parse(item.flow.review.subject);
      }
      return item;
    });
  },
  executionDetail: (token: string, id: string) => request(token, `executions/${encodeURIComponent(id)}/detail`),
  message: (token: string, text: string, voice?: { rawTranscript: string; provider: string; transcribedAt: string }) => request(token, "messages", voice ? { text, inputMode: "VOICE", voice } : { text }) as Promise<Interpretation>,
  clarify: (token: string, bundle: boolean, id: string, answer: { selectedCandidateId: string } | { answerText: string }) => request(token, `${bundle ? "bundle-clarifications" : "clarifications"}/${encodeURIComponent(id)}/answer`, answer) as Promise<Interpretation>,
  confirm: async (token: string, bundle: boolean, id: string) => {
    const value: any = await request(token, `${bundle ? "goal-bundle-candidates" : "goal-candidates"}/${encodeURIComponent(id)}/confirm`, {});
    return bundle ? GoalBundleContractV1.parse(value.goalBundleContract) : GoalContractV1.parse(value.goalContract);
  },
  proposeFunding: (token: string, goalId: string, sourceAccountId: string, minimumSgdReserveMinorUnits?: string) => request(token, `goals/${encodeURIComponent(goalId)}/funding-candidate`, {
    sourceAccountId, ...(minimumSgdReserveMinorUnits === undefined ? {} : { minimumSgdReserveMinorUnits }),
  }) as Promise<Interpretation>,
  compile: async (token: string, bundle: boolean, id: string): Promise<FinancialPlanV1 | { status: string; reason?: { code: string; message: string } }> => {
    const value: any = await request(token, `${bundle ? "goal-bundles" : "goals"}/${encodeURIComponent(id)}/compile`, {});
    if (value.financialPlan) return FinancialPlanV1.parse(value.financialPlan);
    const parsed = CompilerResultV1.safeParse(value);
    if (parsed.success) return parsed.data.status === "SAT" ? parsed.data.plan : parsed.data;
    return { status: String(value.status ?? "UNAVAILABLE"), reason: value.reason };
  },
};
