import { Prisma, type PrismaClient } from "@parlance/db";

export type OpsStageState = "COMPLETE" | "WAITING" | "STOPPED" | "FAILED" | "NOT_REACHED";

export interface OpsAuditEvent {
  id: string;
  eventType: string;
  occurredAt: string;
  aggregateType: string;
  aggregateId: string;
  traceId: string;
  metadata: unknown;
}

export interface OpsStage<T extends Record<string, unknown> = Record<string, unknown>> {
  state: OpsStageState;
  summary: string;
  detail?: T;
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

export interface OpsReadService {
  listRuns(): Promise<OpsRun[]>;
}

const planInclude = {
  steps: { orderBy: { sequence: "asc" } },
  approvals: {
    orderBy: { approvedAt: "desc" },
    select: { id: true, method: true, approvedAt: true, bankStateVersion: true, traceId: true, evidence: { select: { id: true, userVerified: true } } },
  },
  webAuthnChallenges: {
    orderBy: { createdAt: "desc" },
    select: { id: true, status: true, createdAt: true },
  },
  executionRuns: {
    orderBy: { createdAt: "desc" },
    select: {
      id: true, status: true, startedStateVersion: true, finalStateVersion: true, goalOutcome: true, traceId: true, createdAt: true, updatedAt: true,
      steps: {
        select: {
          status: true, bankReference: true, errorCode: true, resultingStateVersion: true,
          planStep: { select: { stepKey: true, sequence: true, action: true } },
        },
      },
    },
  },
  riskAssessments: {
    orderBy: { assessedAt: "desc" },
    take: 1,
    select: {
      id: true, decision: true, reasonCodes: true, exposures: true, rollingUsage: true,
      policyVersion: true, kycStatus: true, bankStateVersion: true, assessedAt: true,
    },
  },
  riskReservations: {
    orderBy: { createdAt: "desc" },
    take: 1,
    select: {
      id: true, status: true, policyVersion: true, createdAt: true, consumedAt: true, releasedAt: true,
      entries: { orderBy: { stepId: "asc" }, select: { stepId: true, action: true, currency: true, minorUnits: true, status: true } },
    },
  },
} satisfies Prisma.FinancialPlanInclude;

const runInclude = {
  conversation: {
    select: {
      messages: {
        where: { role: "USER" },
        orderBy: { createdAt: "asc" },
        take: 1,
        select: { content: true, traceId: true, createdAt: true, inputMode: true, inputMetadata: true },
      },
    },
  },
  goalContracts: {
    orderBy: { version: "desc" },
    include: {
      constraints: { orderBy: { createdAt: "asc" } },
      entityBindings: { orderBy: { createdAt: "asc" } },
      financialPlans: {
        orderBy: { createdAt: "desc" },
        include: planInclude,
      },
    },
  },
  goalBundleContracts: {
    orderBy: { version: "desc" },
    include: { financialPlans: { orderBy: { createdAt: "desc" }, include: planInclude } },
  },
} satisfies Prisma.IntentDraftRecordInclude;

export type OpsRunRow = Prisma.IntentDraftRecordGetPayload<{ include: typeof runInclude }>;
export type OpsAuditRow = Prisma.AuditEventGetPayload<Record<string, never>>;

export class PrismaOpsReadService implements OpsReadService {
  constructor(private readonly db: PrismaClient) {}

  async listRuns(): Promise<OpsRun[]> {
    const rows = await this.db.intentDraftRecord.findMany({
      orderBy: { createdAt: "desc" },
      take: 50,
      include: runInclude,
    });
    if (rows.length === 0) return [];

    const traceIds = new Set<string>();
    const aggregateIds = new Set<string>();
    for (const row of rows) {
      aggregateIds.add(row.id);
      for (const message of row.conversation.messages) if (message.traceId) traceIds.add(message.traceId);
      for (const goal of row.goalContracts) {
        aggregateIds.add(goal.id); aggregateIds.add(goal.contractKey);
        for (const plan of goal.financialPlans) {
          aggregateIds.add(plan.id); if (plan.traceId) traceIds.add(plan.traceId);
          for (const approval of plan.approvals) {
            aggregateIds.add(approval.id); if (approval.traceId) traceIds.add(approval.traceId);
          }
          for (const execution of plan.executionRuns) {
            aggregateIds.add(execution.id); traceIds.add(execution.traceId);
          }
        }
      }
      for (const bundle of row.goalBundleContracts ?? []) {
        aggregateIds.add(bundle.id); aggregateIds.add(bundle.bundleKey);
        for (const plan of bundle.financialPlans) {
          aggregateIds.add(plan.id); if (plan.traceId) traceIds.add(plan.traceId);
          for (const approval of plan.approvals) { aggregateIds.add(approval.id); if (approval.traceId) traceIds.add(approval.traceId); }
          for (const execution of plan.executionRuns) { aggregateIds.add(execution.id); traceIds.add(execution.traceId); }
        }
      }
    }
    const audit = await this.db.auditEvent.findMany({
      where: { OR: [{ traceId: { in: [...traceIds] } }, { aggregateId: { in: [...aggregateIds] } }] },
      orderBy: { occurredAt: "asc" },
      take: 1000,
    });
    return buildOpsRuns(rows, audit);
  }
}

export function buildOpsRuns(rows: readonly OpsRunRow[], auditRows: readonly OpsAuditRow[]): OpsRun[] {
  return rows.map((row) => buildOpsRun(row, auditRows));
}

function buildOpsRun(row: OpsRunRow, allAudit: readonly OpsAuditRow[]): OpsRun {
  const message = row.conversation.messages[0];
  const goal = row.goalContracts[0];
  const bundle = row.goalBundleContracts?.[0];
  const plan = goal?.financialPlans[0] ?? bundle?.financialPlans[0];
  const approval = plan?.approvals[0];
  const challenge = plan?.webAuthnChallenges[0];
  const execution = plan?.executionRuns[0];
  const riskAssessment = plan?.riskAssessments?.[0];
  const riskReservation = plan?.riskReservations?.[0];
  const candidatePayload = record(row.payload);
  const candidate = record(candidatePayload.candidate);
  const intentDraft = record(candidatePayload.intentDraft);
  const candidateGoal = record(candidate.goal);
  const confirmedGoal = goal ? record(goal.goalPayload) : undefined;
  const confirmedBundle = bundle ? record(bundle.payload) : undefined;
  const ids = new Set<string>([row.id]);
  const traces = new Set<string>();
  if (message?.traceId) traces.add(message.traceId);
  if (goal) { ids.add(goal.id); ids.add(goal.contractKey); }
  if (bundle) { ids.add(bundle.id); ids.add(bundle.bundleKey); }
  if (plan) { ids.add(plan.id); if (plan.traceId) traces.add(plan.traceId); }
  if (approval) { ids.add(approval.id); if (approval.traceId) traces.add(approval.traceId); }
  if (execution) { ids.add(execution.id); traces.add(execution.traceId); }
  const audit = allAudit
    .filter((event) => ids.has(event.aggregateId) || traces.has(event.traceId))
    .sort((left, right) => left.occurredAt.getTime() - right.occurredAt.getTime())
    .map(presentAuditEvent);
  const compilationFailure = audit.find((event) => (event.eventType.startsWith("COMPILATION_") || event.eventType.startsWith("BUNDLE_COMPILATION_")) && !event.eventType.endsWith("_SAT"));
  const semanticValidationEvent = [...audit].reverse().find((event) => ["SEMANTIC_VALIDATION_PASSED", "SEMANTIC_VALIDATION_FAILED", "BUNDLE_SEMANTIC_VALIDATION_PASSED", "BUNDLE_SEMANTIC_VALIDATION_FAILED"].includes(event.eventType));
  const semanticValidationStage: OpsStage = semanticValidationEvent?.eventType.endsWith("_PASSED")
    ? { state: "COMPLETE", summary: "Candidate matched the customer-authored request", detail: semanticValidationEvent.metadata as Record<string, unknown> }
    : semanticValidationEvent?.eventType.endsWith("_FAILED")
      ? { state: "STOPPED", summary: "Candidate rejected before meaning confirmation", detail: semanticValidationEvent.metadata as Record<string, unknown> }
      : { state: "NOT_REACHED", summary: "No semantic validation record" };

  const requestDetail: Record<string, unknown> = {
    input: message?.inputMode === "VOICE" ? "Voice" : "Typed",
    customerText: message?.content ?? text(candidatePayload.originalText) ?? text(intentDraft.originalText) ?? "Request text unavailable",
    timestamp: (message?.createdAt ?? row.createdAt).toISOString(),
    userId: shortIdentifier(row.userId),
    traceId: message?.traceId ? shortIdentifier(message.traceId) : "not recorded",
  };
  if (message?.inputMode === "VOICE") {
    const metadata = record(message.inputMetadata);
    requestDetail.transcript = text(metadata.rawTranscript) ?? "Transcript unavailable";
    requestDetail.customerEdit = metadata.edited === true ? "Edited" : "Unchanged";
    requestDetail.submittedText = message.content;
    requestDetail.provider = text(metadata.provider) ?? "not recorded";
    requestDetail.transcribedAt = text(metadata.transcribedAt) ?? "not recorded";
  }
  const bundleItems = list(candidate.items).map((value) => record(value));
  const interpretationDetail: Record<string, unknown> = bundleItems.length > 0 ? {
    interpretationType: "BUNDLE",
    itemCount: bundleItems.length,
    items: bundleItems.map((item, index) => ({ sequence: index + 1, summary: summarizeGoal(record(item.goal)), bindingCount: list(item.bindings).length })),
    globalConstraintCount: list(candidate.globalConstraints).length,
    explicitDependencyCount: list(candidate.explicitDependencies).length,
    semanticCandidateStatus: row.status,
  } : {
    goalType: text(candidateGoal.type) ?? text(record(intentDraft.goal).type) ?? "unknown",
    intentSummary: summarizeGoal(presentRecord(candidateGoal) ? candidateGoal : record(intentDraft.goal)),
    groundedEntities: list(candidate.entityBindings).map((value) => {
      const binding = record(value);
      return {
        reference: text(binding.reference) ?? "unknown",
        entityType: text(binding.entityType) ?? "unknown",
        canonicalId: shortIdentifier(text(binding.entityId) ?? "unknown"),
        resolutionMethod: text(binding.resolutionMethod) ?? "unknown",
      };
    }),
    clarificationOutcome: list(candidate.entityBindings).some((value) => record(value).resolutionMethod === "USER_CONFIRMED")
      ? "user confirmed an ambiguous reference"
      : /(?:^|\n)clarification:/i.test(text(intentDraft.originalText) ?? "") ? "clarification incorporated into the interpreted request" : "no clarification recorded",
    semanticCandidateStatus: row.status,
  };

  const confirmedGoalStage: OpsStage = bundle ? {
    state: "COMPLETE",
    summary: `${list(confirmedBundle?.items).length} confirmed goals in one bundle`,
    detail: {
      ownerType: "BUNDLE", bundleVersion: bundle.version, contractHash: shortHash(bundle.contractHash), confirmedAt: bundle.confirmedAt?.toISOString() ?? "not recorded",
      items: list(confirmedBundle?.items).map((value, index) => ({ sequence: index + 1, summary: summarizeGoal(record(record(value).goal)) })),
      globalConstraints: safeJson(confirmedBundle?.globalConstraints ?? []), explicitDependencies: safeJson(confirmedBundle?.explicitDependencies ?? []),
    },
  } : goal ? {
    state: "COMPLETE",
    summary: `${text(confirmedGoal?.type) ?? "Goal"} confirmed`,
    detail: {
      goalType: text(confirmedGoal?.type) ?? "unknown",
      goal: safeJson(goal.goalPayload),
      constraints: goal.constraints.map((constraint) => ({ type: constraint.type, ...withoutSequence(record(safeJson(constraint.payload))) })),
      preferences: safeJson(goal.preferences),
      confirmedBindings: goal.entityBindings.map((binding) => ({
        reference: binding.reference,
        entityType: binding.entityType,
        canonicalId: shortIdentifier(binding.entityId),
        resolutionMethod: binding.resolutionMethod,
        confirmed: binding.confirmed,
      })),
      contractVersion: goal.version,
      contractHash: shortHash(goal.contractHash),
      confirmedAt: goal.confirmedAt?.toISOString() ?? "not recorded",
    },
  } : row.status === "SEMANTIC_VALIDATION_FAILED" ? {
    state: "NOT_REACHED", summary: "Semantic candidate was not accepted",
  } : { state: "WAITING", summary: "Waiting for meaning confirmation", detail: { candidateId: shortIdentifier(row.id), candidateStatus: row.status } };

  let planStage: OpsStage;
  if (plan) {
    planStage = {
      state: "COMPLETE",
      summary: `SAT · ${plan.steps.length} deterministic action${plan.steps.length === 1 ? "" : "s"}`,
      detail: {
        compilerOutcome: "SAT",
        compilerVersion: plan.compilerVersion,
        bankStateVersion: plan.bankStateVersion,
        planHash: shortHash(plan.planHash),
        actions: plan.steps.map((step) => ({
          sequence: step.sequence,
          stepId: shortIdentifier(step.stepKey),
          action: step.action,
          dependsOn: safeJson(step.dependsOn),
          reversible: step.reversible,
          parameters: safeJson(step.parameters),
        })),
        requiredQuoteIds: list(record(plan.validity).requiredQuoteIds).map((value) => shortIdentifier(String(value))),
        warnings: safeJson(record(plan.projectedOutcome).warnings ?? []),
        ...(plan.satisfactionProof === null ? {} : { satisfactionProof: safeJson(plan.satisfactionProof) }),
      },
    };
  } else if (compilationFailure) {
    planStage = { state: "STOPPED", summary: compilationFailure.eventType.replace("COMPILATION_", ""), detail: { compilerOutcome: compilationFailure.eventType.replace("COMPILATION_", ""), event: compilationFailure.metadata } };
  } else {
    planStage = { state: "NOT_REACHED", summary: goal ? "No compiler result recorded" : "Meaning not yet confirmed" };
  }

  const authorizationStage = authorization(!!plan, approval, challenge, riskAssessment, riskReservation);
  const executionStage = executionStatus(!!approval?.evidence, execution);
  const bankResultStage = bankResult(execution);

  return {
    id: shortIdentifier(row.id),
    occurredAt: row.createdAt.toISOString(),
    headline: message?.content ?? text(candidatePayload.originalText) ?? text(intentDraft.originalText) ?? "Request text unavailable",
    overallState: overallState(execution, authorizationStage, planStage, confirmedGoalStage, semanticValidationStage),
    stages: {
      request: { state: "COMPLETE", summary: "Customer request recorded", detail: requestDetail },
      interpretation: { state: "COMPLETE", summary: bundleItems.length > 0 ? `${bundleItems.length} financial intents interpreted` : summarizeGoal(presentRecord(candidateGoal) ? candidateGoal : record(intentDraft.goal)), detail: interpretationDetail },
      semanticValidation: semanticValidationStage,
      confirmedGoal: confirmedGoalStage,
      plan: planStage,
      authorization: authorizationStage,
      execution: executionStage,
      bankResult: bankResultStage,
    },
    audit,
  };
}

type OpsPlan = OpsRunRow["goalContracts"][number]["financialPlans"][number];

function authorization(
  planExists: boolean,
  approval: OpsPlan["approvals"][number] | undefined,
  challenge: OpsPlan["webAuthnChallenges"][number] | undefined,
  riskAssessment: OpsPlan["riskAssessments"][number] | undefined,
  riskReservation: OpsPlan["riskReservations"][number] | undefined,
): OpsStage {
  const risk = riskAssessment ? {
    decision: riskAssessment.decision,
    reasonCodes: safeJson(riskAssessment.reasonCodes),
    exposures: safeJson(riskAssessment.exposures),
    rollingUsage: safeJson(riskAssessment.rollingUsage),
    policyVersion: riskAssessment.policyVersion,
    kycStatus: riskAssessment.kycStatus,
    bankStateVersion: riskAssessment.bankStateVersion,
    assessedAt: riskAssessment.assessedAt.toISOString(),
    assessmentId: shortIdentifier(riskAssessment.id),
    reservation: riskReservation ? {
      id: shortIdentifier(riskReservation.id),
      status: riskReservation.status,
      policyVersion: riskReservation.policyVersion,
      entries: riskReservation.entries.map((entry) => ({
        stepId: shortIdentifier(entry.stepId), action: entry.action, currency: entry.currency,
        minorUnits: entry.minorUnits.toString(), status: entry.status,
      })),
      consumedAt: riskReservation.consumedAt?.toISOString() ?? "not consumed",
      releasedAt: riskReservation.releasedAt?.toISOString() ?? "not released",
    } : "none",
  } : undefined;

  if (riskAssessment && riskAssessment.decision !== "ALLOW") {
    return {
      state: "STOPPED",
      summary: `Risk decision: ${riskAssessment.decision}`,
      detail: { risk },
    };
  }
  if (approval) {
    return {
      state: approval.evidence ? "COMPLETE" : "FAILED",
      summary: approval.evidence ? "Verified passkey evidence recorded" : "Approval exists without verification evidence",
      detail: {
        method: approval.method,
        userVerified: approval.evidence?.userVerified ?? false,
        approvalEvidence: approval.evidence ? "present" : "missing",
        challengeStatus: challenge?.status ?? (approval.evidence ? "CONSUMED" : "unknown"),
        authorizedAt: approval.approvedAt.toISOString(),
        approvedBankStateVersion: approval.bankStateVersion,
        approvalId: shortIdentifier(approval.id),
        evidenceId: approval.evidence ? shortIdentifier(approval.evidence.id) : "missing",
        ...(risk ? { risk } : {}),
      },
    };
  }
  if (!planExists) return { state: "NOT_REACHED", summary: "No plan to authorize" };
  if (challenge?.status === "REVOKED" || challenge?.status === "EXPIRED" || challenge?.status === "CONSUMED") {
    return {
      state: "FAILED",
      summary: challenge.status === "CONSUMED" ? "Challenge consumed without ApprovalEvidence" : `Passkey challenge ${challenge.status.toLowerCase()}`,
      detail: { method: "PASSKEY", userVerified: false, approvalEvidence: "missing", challengeStatus: challenge.status, challengeId: shortIdentifier(challenge.id), ...(risk ? { risk } : {}) },
    };
  }
  return {
    state: "WAITING",
    summary: challenge ? "Passkey challenge issued" : "Waiting for passkey authorization",
    ...((challenge || risk) ? { detail: { ...(challenge ? { method: "PASSKEY", userVerified: false, approvalEvidence: "missing", challengeStatus: challenge.status, challengeId: shortIdentifier(challenge.id) } : {}), ...(risk ? { risk } : {}) } } : {}),
  };
}

function executionStatus(evidencePresent: boolean, execution: OpsRunRow["goalContracts"][number]["financialPlans"][number]["executionRuns"][number] | undefined): OpsStage {
  if (!execution) return { state: evidencePresent ? "WAITING" : "NOT_REACHED", summary: evidencePresent ? "Authorized; execution not started" : "Authorization not complete" };
  const reconciling = execution.steps.some((step) => step.status === "UNKNOWN" && ["BANK_RESPONSE_OUTCOME_UNKNOWN", "BANK_LOOKUP_UNAVAILABLE"].includes(step.errorCode ?? ""));
  const state: OpsStageState = execution.status === "COMPLETED" ? "COMPLETE" : execution.status === "FAILED" ? "FAILED" : reconciling ? "WAITING" : execution.status === "PAUSED" || execution.status === "REAPPROVAL_REQUIRED" ? "STOPPED" : "WAITING";
  return {
    state,
    summary: reconciling ? "Bank outcome reconciliation required" : execution.status === "REAPPROVAL_REQUIRED" ? "Route changed — prior authorization cannot continue" : `Execution ${execution.status.toLowerCase()}`,
    detail: {
      executionId: shortIdentifier(execution.id),
      state: execution.status,
      startedStateVersion: execution.startedStateVersion,
      finalStateVersion: execution.finalStateVersion ?? "pending",
      revalidation: execution.status === "REAPPROVAL_REQUIRED" ? "new approval required" : execution.status === "PAUSED" ? "stopped for safe review" : "no reapproval recorded",
      steps: execution.steps.slice().sort((left, right) => left.planStep.sequence - right.planStep.sequence).map((step) => ({
        sequence: step.planStep.sequence,
        stepId: shortIdentifier(step.planStep.stepKey),
        proposedAction: step.planStep.action,
        decision: step.status === "SETTLED" ? "executed" : step.status === "UNKNOWN" && ["BANK_RESPONSE_OUTCOME_UNKNOWN", "BANK_LOOKUP_UNAVAILABLE"].includes(step.errorCode ?? "") ? "reconciling" : step.status === "FAILED" || step.status === "UNKNOWN" ? "prevented" : step.status === "ACCEPTED" ? "allowed" : "pending",
        status: step.status,
        reasonCode: step.errorCode ?? "none",
        resultingStateVersion: step.resultingStateVersion ?? "not recorded",
        bankReference: step.bankReference ? shortIdentifier(step.bankReference) : "not recorded",
      })),
    },
  };
}

function bankResult(execution: OpsRunRow["goalContracts"][number]["financialPlans"][number]["executionRuns"][number] | undefined): OpsStage {
  if (!execution) return { state: "NOT_REACHED", summary: "Execution never reached the bank" };
  const settled = execution.steps.filter((step) => step.status === "SETTLED");
  const reconciling = execution.steps.some((step) => step.status === "UNKNOWN" && ["BANK_RESPONSE_OUTCOME_UNKNOWN", "BANK_LOOKUP_UNAVAILABLE"].includes(step.errorCode ?? ""));
  const state: OpsStageState = execution.status === "COMPLETED" ? "COMPLETE" : execution.status === "FAILED" ? "FAILED" : reconciling ? "WAITING" : execution.status === "PAUSED" || execution.status === "REAPPROVAL_REQUIRED" ? "STOPPED" : "WAITING";
  return {
    state,
    summary: settled.length > 0 ? `${settled.length} bank operation${settled.length === 1 ? "" : "s"} settled` : "No settled bank operation recorded",
    detail: {
      settledOperations: settled.map((step) => ({ action: step.planStep.action, bankReference: step.bankReference ? shortIdentifier(step.bankReference) : "not recorded", resultingStateVersion: step.resultingStateVersion ?? "not recorded" })),
      reconciliation: execution.status === "COMPLETED" ? "confirmed with bank" : reconciling ? "confirming transaction status" : "not complete",
      goalOutcome: safeJson(execution.goalOutcome),
    },
  };
}

function overallState(execution: OpsRunRow["goalContracts"][number]["financialPlans"][number]["executionRuns"][number] | undefined, authorizationStage: OpsStage, planStage: OpsStage, goalStage: OpsStage, semanticValidationStage: OpsStage): string {
  if (execution) return execution.status;
  if (semanticValidationStage.state === "STOPPED") return "SEMANTIC_VALIDATION_FAILED";
  if (authorizationStage.state === "STOPPED") return `RISK_${text(record(authorizationStage.detail?.risk).decision) ?? "STOPPED"}`;
  if (authorizationStage.state === "FAILED") return "AUTHORIZATION_FAILED";
  if (authorizationStage.state === "WAITING") return "AWAITING_AUTHORIZATION";
  if (planStage.state === "STOPPED") return String(planStage.detail?.compilerOutcome ?? "COMPILATION_STOPPED");
  if (planStage.state === "COMPLETE") return "PLAN_READY";
  if (goalStage.state === "COMPLETE") return "GOAL_CONFIRMED";
  return "AWAITING_MEANING_CONFIRMATION";
}

function presentAuditEvent(event: OpsAuditRow): OpsAuditEvent {
  return {
    id: shortIdentifier(event.id),
    eventType: event.eventType,
    occurredAt: event.occurredAt.toISOString(),
    aggregateType: event.aggregateType,
    aggregateId: shortIdentifier(event.aggregateId),
    traceId: shortIdentifier(event.traceId),
    metadata: safeJson(event.payload),
  };
}

const forbiddenKey = /(authorization|credential|public.?key|signature|challenge(?!status)|cookie|session|bearer|token|secret|api.?key|prompt|provider|attestation|client.?data|authenticator.?data|raw.?response)/i;

export function safeJson(value: unknown, seen = new WeakSet<object>(), key?: string): unknown {
  if (typeof value === "string") {
    if (/^(bearer\s+|sk-[a-z0-9_-]{8,}|eyJ[a-z0-9_-]+\.[a-z0-9_-]+\.)/i.test(value)) return "[redacted]";
    if (key && /hash$/i.test(key)) return shortHash(value);
    if (key && /ids?$/i.test(key)) return shortIdentifier(value);
    return value;
  }
  if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "object") return "[redacted]";
  if (seen.has(value)) return "[redacted circular value]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => safeJson(item, seen, key));
  const output: Record<string, unknown> = {};
  for (const [childKey, child] of Object.entries(value)) output[childKey] = forbiddenKey.test(childKey) ? "[redacted]" : safeJson(child, seen, childKey);
  return output;
}

export function shortIdentifier(value: string): string {
  if (value.length <= 16) return value;
  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}

function shortHash(value: string): string {
  if (value.length <= 20) return value;
  return `${value.slice(0, 12)}…${value.slice(-8)}`;
}

function summarizeGoal(goal: MapLike): string {
  const type = text(goal.type) ?? "Unknown intent";
  const money = record(goal.amount ?? goal.budget);
  const amount = text(money.currency) && text(money.minorUnits) ? `${text(money.currency)} ${text(money.minorUnits)} minor units` : undefined;
  const destination = text(goal.recipientId ?? goal.recipientReference ?? goal.assetId ?? goal.assetReference ?? goal.billerId ?? goal.billerReference ?? goal.destinationAccountId ?? goal.destinationAccountReference);
  return [type.replaceAll("_", " "), amount, destination].filter(Boolean).join(" · ");
}

type MapLike = Record<string, unknown>;
function record(value: unknown): MapLike {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as MapLike : {};
}
function presentRecord(value: MapLike): boolean { return Object.keys(value).length > 0; }
function list(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function text(value: unknown): string | undefined { return typeof value === "string" && value.length > 0 ? value : undefined; }
function withoutSequence(value: MapLike): Record<string, unknown> { const rest = { ...value }; delete rest.__sequence; return rest; }
