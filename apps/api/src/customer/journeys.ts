import type { PrismaClient } from "@parlance/db";
import { PrismaParlanceRepository } from "../repositories/prisma.js";

type StoredPayload = { kind?: unknown; originalText?: unknown };
function payloadOf(value: unknown): StoredPayload { return value && typeof value === "object" && !Array.isArray(value) ? value as StoredPayload : {}; }

export class PrismaCustomerJourneysReadService {
  constructor(private readonly db: PrismaClient, private readonly repository = new PrismaParlanceRepository(db)) {}

  async list(userId: string) {
    const [drafts, plans] = await Promise.all([
      this.db.intentDraftRecord.findMany({ where: { userId, status: { in: ["NEEDS_CLARIFICATION", "AWAITING_GOAL_CONFIRMATION"] } }, orderBy: { updatedAt: "desc" }, take: 10, select: { id: true, status: true, payload: true, updatedAt: true } }),
      this.db.financialPlan.findMany({ where: { status: "READY", OR: [{ goalContract: { userId } }, { goalBundle: { userId } }] }, orderBy: { createdAt: "desc" }, take: 10,
        select: { id: true, updatedAt: true, goalContractKey: true, goalContractRowId: true, goalBundleRowId: true,
          goalContract: { select: { sourceIntentDraft: { select: { payload: true } } } }, goalBundle: { select: { sourceIntentDraft: { select: { payload: true } } } },
        } }),
    ]);
    const pending = await Promise.all(drafts.map(async (row) => {
      const payload = payloadOf(row.payload); const request = typeof payload.originalText === "string" ? payload.originalText : "Saved banking request";
      if (row.status === "NEEDS_CLARIFICATION") {
        const bundle = payload.kind === "BUNDLE_CLARIFICATION_PENDING_V1";
        if (!bundle && payload.kind !== "CLARIFICATION_PENDING_V1") return;
        const stored = bundle ? await this.repository.getBundleClarification(row.id) : await this.repository.getClarification(row.id);
        if (!stored) return;
        return { id: row.id, updatedAt: row.updatedAt.toISOString(), request, flow: { phase: "CLARIFY" as const, data: {
          status: bundle ? "NEEDS_BUNDLE_CLARIFICATION" as const : "NEEDS_CLARIFICATION" as const, clarificationId: row.id, clarifications: stored.clarifications,
        } } };
      }
      const bundle = payload.kind === "GOAL_BUNDLE_CANDIDATE_V1";
      if (!bundle && payload.kind !== "GOAL_CANDIDATE_V1") return;
      const stored = bundle ? await this.repository.getBundleCandidate(row.id) : await this.repository.getGoalCandidate(row.id);
      if (!stored) return;
      return { id: row.id, updatedAt: row.updatedAt.toISOString(), request, flow: { phase: "MEANING" as const, data: bundle
        ? { status: "AWAITING_BUNDLE_CONFIRMATION" as const, candidateId: row.id, goalBundleCandidate: stored.candidate }
        : { status: "AWAITING_GOAL_CONFIRMATION" as const, candidateId: row.id, goalCandidate: stored.candidate },
      } };
    }));
    const ready = await Promise.all(plans.map(async (row) => {
      const stored = await this.repository.getPlan(row.id);
      if (!stored || stored.status !== "READY") return;
      const bundle = row.goalBundleRowId !== null;
      const subject = bundle ? await this.repository.getConfirmedGoalBundle(row.goalContractKey) : await this.repository.getConfirmedGoal(row.goalContractKey);
      if (!subject || (!bundle && "userId" in subject.contract && subject.contract.userId !== userId)) return;
      const sourcePayload = payloadOf(bundle ? row.goalBundle?.sourceIntentDraft.payload : row.goalContract?.sourceIntentDraft?.payload);
      return { id: row.id, updatedAt: row.updatedAt.toISOString(), request: typeof sourcePayload.originalText === "string" ? sourcePayload.originalText : "Saved financial plan",
        flow: { phase: "PLAN" as const, review: { kind: bundle ? "BUNDLE" as const : "GOAL" as const, id: row.goalContractKey, subject: subject.contract, plan: stored.plan } },
      };
    }));
    return { items: [...pending, ...ready].filter((item): item is NonNullable<typeof item> => !!item).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 20) };
  }
}
