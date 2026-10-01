import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BankStateSnapshotV1, GoalContractV1, type IntentDraftV1 } from "@parlance/contracts";
import type { EntityGrounder, EntityGroundingInput, EntityGroundingResult, IntentInterpreter } from "@parlance/intent-engine";
import { describe, expect, it, vi } from "vitest";
import { hashGoalContract } from "../security/canonical-hash.js";
import type { GoalConfirmationMetadata, GoalConfirmationRepository, ParlanceRepository, StoredClarificationRequest, StoredGoal, StoredGoalCandidate } from "./ports.js";
import { CompilationService, MessageOrchestrationService } from "./services.js";

const snapshot = BankStateSnapshotV1.parse(JSON.parse(readFileSync(join(process.cwd(), "../../packages/contracts/fixtures/01-ntu-transfer/bank-state.json"), "utf8")));
const transferDraft: IntentDraftV1 = {
  schemaVersion: "1", originalText: "send $500 to NTU",
  goal: { type: "DELIVER_MONEY", amount: { currency: "USD", minorUnits: "50000" }, recipientReference: "NTU" },
  constraints: [], preferences: [], references: [],
};

class CandidateRepository implements GoalConfirmationRepository {
  candidate?: StoredGoalCandidate;
  clarification: StoredClarificationRequest | undefined;
  goal?: StoredGoal;
  confirmations = 0;
  clarificationAdvances = 0;
  async saveClarification(input: Parameters<GoalConfirmationRepository["saveClarification"]>[0]) { this.clarification = input; return input; }
  async getClarification(id: string) { return this.clarification?.clarificationId === id ? this.clarification : null; }
  async advanceClarification(input: Parameters<GoalConfirmationRepository["advanceClarification"]>[0]) {
    this.clarificationAdvances += 1;
    if (!this.clarification || this.clarification.clarificationId !== input.clarificationId) throw new Error("CLARIFICATION_NOT_FOUND");
    if (input.candidate) {
      this.candidate = { candidateId: this.clarification.clarificationId, goalContractId: this.clarification.goalContractId, userId: this.clarification.userId, version: this.clarification.version, createdAt: this.clarification.createdAt, candidate: input.candidate };
      this.clarification = undefined; return { status: "AWAITING_GOAL_CONFIRMATION" as const, candidate: this.candidate };
    }
    this.clarification = { ...this.clarification, groundingResults: input.groundingResults, clarifications: input.clarifications };
    return { status: "NEEDS_CLARIFICATION" as const, request: this.clarification };
  }
  async saveGoalCandidate(input: Parameters<GoalConfirmationRepository["saveGoalCandidate"]>[0]) {
    this.candidate = { candidateId: input.candidateId, goalContractId: input.goalContractId, userId: input.userId, version: input.version, createdAt: input.createdAt, candidate: input.candidate };
    return this.candidate;
  }
  async getGoalCandidate(id: string) { return this.candidate?.candidateId === id ? this.candidate : null; }
  async confirmGoal(input: { candidateId: string; contract: GoalContractV1; confirmation: GoalConfirmationMetadata }) {
    if (this.goal) return this.goal;
    if (this.candidate?.candidateId !== input.candidateId) throw new Error("GOAL_CANDIDATE_NOT_CONFIRMABLE");
    this.confirmations += 1;
    this.goal = { rowId: "goal-row", contract: input.contract };
    return this.goal;
  }
}

class FixedInterpreter implements IntentInterpreter {
  constructor(private readonly draft: IntentDraftV1) {}
  async interpretUserRequest() { return this.draft; }
}

class FixedGrounder implements EntityGrounder {
  constructor(private readonly result: (input: EntityGroundingInput) => EntityGroundingResult) {}
  async ground(input: EntityGroundingInput) { return this.result(input); }
}

const exactGrounder = () => new FixedGrounder((input) => ({ status: "RESOLVED", reference: input.reference, entityType: "BENEFICIARY", entityId: "ben-ntu", resolutionMethod: "EXACT" }));
const ids = ["candidate-1", "goal-1"];
const service = (repository: CandidateRepository, grounder: EntityGrounder = exactGrounder()) => new MessageOrchestrationService(
  repository, new FixedInterpreter(transferDraft), () => grounder, undefined, undefined,
  () => new Date("2026-09-25T10:00:00Z"), () => ids.shift() ?? "unexpected-id",
);

function confirmedGoal(overrides: Partial<GoalContractV1> = {}): GoalContractV1 {
  const raw = GoalContractV1.parse({
    schemaVersion: "1", id: "goal-1", userId: "user-1", version: 1, sourceIntentDraftId: "candidate-1",
    goal: { type: "DELIVER_MONEY", amount: { currency: "USD", minorUnits: "50000" }, recipientId: "ben-ntu" }, constraints: [], preferences: [],
    entityBindings: [{ schemaVersion: "1", reference: "NTU", entityType: "BENEFICIARY", entityId: "ben-ntu", resolutionMethod: "EXACT", confirmed: true }],
    status: "CONFIRMED", contractHash: "0".repeat(64), createdAt: "2026-09-25T10:00:00Z", confirmedAt: "2026-09-25T10:01:00Z", ...overrides,
  });
  return GoalContractV1.parse({ ...raw, contractHash: hashGoalContract(raw) });
}

function compilationRepository(goal: GoalContractV1): ParlanceRepository {
  return {
    getConfirmedGoal: async () => ({ rowId: "goal-row", contract: goal }), saveSnapshot: async () => {}, saveCompilationFailure: async () => {},
  } as unknown as ParlanceRepository;
}

describe("Person B to Person A confirmation boundary", () => {
  it("grounds, waits for explicit confirmation, persists a semantic hash, and sends only GoalContractV1 to Person C", async () => {
    ids.splice(0, ids.length, "candidate-1", "goal-1");
    const repository = new CandidateRepository(); const messages = service(repository);
    const awaiting = await messages.receive({ userId: "user-1", text: transferDraft.originalText }, "trace-message");
    expect(awaiting).toEqual(expect.objectContaining({ status: "AWAITING_GOAL_CONFIRMATION", candidateId: "candidate-1" }));
    expect(repository.goal).toBeUndefined();
    const confirmed = await messages.confirm("candidate-1", "trace-confirm");
    expect(confirmed.goalContract).toEqual(GoalContractV1.parse(confirmed.goalContract));
    expect(confirmed.goalContract.status).toBe("CONFIRMED");
    expect(confirmed.goalContract.confirmedAt).toBe("2026-09-25T10:00:00.000Z");
    expect(hashGoalContract(confirmed.goalContract)).toBe(confirmed.goalContract.contractHash);
    expect(confirmed.confirmation).toEqual(expect.objectContaining({ confirmationType: "EXPLICIT_USER_CONFIRMATION", contractHash: confirmed.goalContract.contractHash }));

    const compile = vi.fn(async () => ({ schemaVersion: "1" as const, status: "UNSAT" as const, reason: { code: "TEST_UNSAT", message: "No route." }, relaxations: [] }));
    const compiler = new CompilationService(compilationRepository(confirmed.goalContract), { getState: async () => snapshot } as never, { compile });
    await compiler.compile(confirmed.goalContract.id, "trace-compile");
    expect(compile).toHaveBeenCalledTimes(1);
    expect(compile).toHaveBeenCalledWith(confirmed.goalContract, snapshot, "trace-compile");
  });

  it("returns clarification for two matching Johns and creates no candidate or compiler call", async () => {
    const draft = { ...transferDraft, originalText: "send $500 to John", goal: { ...transferDraft.goal, recipientReference: "John" } } as IntentDraftV1;
    const repository = new CandidateRepository(); const compile = vi.fn();
    const messages = new MessageOrchestrationService(repository, new FixedInterpreter(draft), () => new FixedGrounder((input) => ({
      status: "AMBIGUOUS", reference: input.reference, expectedEntityType: "BENEFICIARY", candidates: [
        { entityType: "BENEFICIARY", entityId: "ben-john-1", canonicalName: "John Tan" },
        { entityType: "BENEFICIARY", entityId: "ben-john-2", canonicalName: "John Lim" },
      ],
    })));
    const result = await messages.receive({ userId: "user-1", text: draft.originalText }, "trace-ambiguous");
    expect(result).toMatchObject({ status: "NEEDS_CLARIFICATION", clarificationId: expect.any(String) }); expect(repository.candidate).toBeUndefined(); expect(repository.goal).toBeUndefined(); expect(compile).not.toHaveBeenCalled();
    if (result.status !== "NEEDS_CLARIFICATION") throw new Error("Expected clarification");
    const continued = await messages.answerClarification(result.clarificationId, { selectedCandidateId: "ben-john-2" }, "trace-answer");
    expect(continued).toMatchObject({ status: "AWAITING_GOAL_CONFIRMATION", goalCandidate: { goal: { recipientId: "ben-john-2", amount: { currency: "USD", minorUnits: "50000" } } } });
    expect(repository.goal).toBeUndefined(); expect(repository.confirmations).toBe(0);
  });

  it("continues a persisted account clarification without reinterpreting the original amount or recipient", async () => {
    const draft: IntentDraftV1 = { ...transferDraft, originalText: "Send NTU USD 7000 using my SGD account", goal: { type: "DELIVER_MONEY", amount: { currency: "USD", minorUnits: "700000" }, recipientReference: "NTU" }, preferences: [{ type: "PREFER_ACCOUNT", accountReference: "my SGD account" }] };
    const interpreter = new FixedInterpreter(draft); const interpret = vi.spyOn(interpreter, "interpretUserRequest"); const repository = new CandidateRepository();
    const grounder = new FixedGrounder((input) => input.expectedEntityType === "BENEFICIARY"
      ? { status: "RESOLVED", reference: input.reference, entityType: "BENEFICIARY", entityId: "ben-ntu", resolutionMethod: "ALIAS" }
      : { status: "AMBIGUOUS", reference: input.reference, expectedEntityType: "ACCOUNT", candidates: [
        { entityType: "ACCOUNT", entityId: "acc-sgd-main", canonicalName: "DBS Multiplier Account", account: { currency: "SGD", accountType: "CHECKING", availableMinorUnits: "1733334" } },
        { entityType: "ACCOUNT", entityId: "acc-sgd-save", canonicalName: "Savings Account", account: { currency: "SGD", accountType: "SAVINGS", availableMinorUnits: "842000" } },
      ] });
    const messages = new MessageOrchestrationService(repository, interpreter, () => grounder, undefined, undefined, () => new Date("2026-09-25T10:00:00Z"), (() => { const values = ["clarification-1", "goal-1"]; return () => values.shift()!; })());
    const pending = await messages.receive({ userId: "user-1", text: draft.originalText }, "trace-message");
    expect(pending).toMatchObject({ status: "NEEDS_CLARIFICATION", clarificationId: "clarification-1", clarifications: [{ options: [{ entityId: "acc-sgd-main" }, { entityId: "acc-sgd-save" }] }] });
    const continued = await messages.answerClarification("clarification-1", { selectedCandidateId: "acc-sgd-main" }, "trace-answer");
    expect(continued).toMatchObject({ status: "AWAITING_GOAL_CONFIRMATION", candidateId: "clarification-1", goalCandidate: {
      goal: { amount: { currency: "USD", minorUnits: "700000" }, recipientId: "ben-ntu" }, preferences: [{ type: "PREFER_ACCOUNT", accountId: "acc-sgd-main" }],
    } });
    if (continued.status !== "AWAITING_GOAL_CONFIRMATION") throw new Error("Expected candidate");
    expect(continued.goalCandidate.entityBindings).toEqual(expect.arrayContaining([expect.objectContaining({ entityId: "acc-sgd-main", resolutionMethod: "USER_CONFIRMED", confirmed: false })]));
    expect(interpret).toHaveBeenCalledTimes(1); expect(repository.goal).toBeUndefined(); expect(repository.confirmations).toBe(0);
  });

  it("grounds a typed clarification server-side and makes duplicate answers side-effect free", async () => {
    const draft: IntentDraftV1 = { ...transferDraft, preferences: [{ type: "PREFER_ACCOUNT", accountReference: "my SGD account" }] };
    const repository = new CandidateRepository();
    const grounder = new FixedGrounder((input) => input.expectedEntityType === "BENEFICIARY"
      ? { status: "RESOLVED", reference: input.reference, entityType: "BENEFICIARY", entityId: "ben-ntu", resolutionMethod: "ALIAS" }
      : input.reference === "DBS Multiplier Account"
        ? { status: "RESOLVED", reference: input.reference, entityType: "ACCOUNT", entityId: "acc-sgd-main", resolutionMethod: "ALIAS" }
        : { status: "NOT_FOUND", reference: input.reference, expectedEntityType: "ACCOUNT" });
    const messages = new MessageOrchestrationService(repository, new FixedInterpreter(draft), () => grounder, undefined, undefined, undefined, (() => { const values = ["clarification-typed", "goal-typed"]; return () => values.shift()!; })());
    await messages.receive({ userId: "user-1", text: draft.originalText }, "trace-message");
    const first = await messages.answerClarification("clarification-typed", { answerText: "DBS Multiplier Account" }, "trace-answer");
    const duplicate = await messages.answerClarification("clarification-typed", { answerText: "DBS Multiplier Account" }, "trace-duplicate");
    expect(first).toEqual(duplicate); expect(repository.clarificationAdvances).toBe(1); expect(repository.goal).toBeUndefined();
  });

  it("keeps an unknown typed account as a safe conversational no-match", async () => {
    const draft: IntentDraftV1 = { ...transferDraft, preferences: [{ type: "PREFER_ACCOUNT", accountReference: "my SGD account" }] };
    const repository = new CandidateRepository(); const grounder = new FixedGrounder((input) => input.expectedEntityType === "BENEFICIARY"
      ? { status: "RESOLVED", reference: input.reference, entityType: "BENEFICIARY", entityId: "ben-ntu", resolutionMethod: "ALIAS" }
      : { status: "NOT_FOUND", reference: input.reference, expectedEntityType: "ACCOUNT" });
    const messages = new MessageOrchestrationService(repository, new FixedInterpreter(draft), () => grounder, undefined, undefined, undefined, (() => { const values = ["clarification-missing", "goal-missing"]; return () => values.shift()!; })());
    await messages.receive({ userId: "user-1", text: draft.originalText }, "trace-message");
    const result = await messages.answerClarification("clarification-missing", { answerText: "Unknown account" }, "trace-answer");
    expect(result).toMatchObject({ status: "NEEDS_CLARIFICATION", clarificationId: "clarification-missing", clarifications: [{ options: [] }] });
    expect(repository.candidate).toBeUndefined(); expect(repository.goal).toBeUndefined();
  });

  it("does not create a goal candidate for unresolved semantic candidates", async () => {
    const repository = new CandidateRepository();
    const result = await service(repository, new FixedGrounder((input) => ({ status: "CANDIDATES", reference: input.reference, expectedEntityType: "BENEFICIARY", candidates: [{ entityType: "BENEFICIARY", entityId: "ben-possible", canonicalName: "Possible NTU", similarityScore: 0.8 }] }))).receive({ userId: "user-1", text: transferDraft.originalText }, "trace-semantic");
    expect(result.status).toBe("NEEDS_CLARIFICATION"); expect(repository.candidate).toBeUndefined(); expect(repository.goal).toBeUndefined();
  });

  it("makes concurrent confirmations one authoritative transition", async () => {
    ids.splice(0, ids.length, "candidate-1", "goal-1");
    const repository = new CandidateRepository(); const messages = service(repository);
    await messages.receive({ userId: "user-1", text: transferDraft.originalText }, "trace-message");
    const [first, second] = await Promise.all([messages.confirm("candidate-1", "trace-one"), messages.confirm("candidate-1", "trace-two")]);
    expect(repository.confirmations).toBe(1); expect(first.goalContract).toEqual(second.goalContract);
  });
});

describe("Person A to Person C compiler boundary", () => {
  it("rejects an unconfirmed contract before bank or compiler calls", async () => {
    const unconfirmed = confirmedGoal({ status: "AWAITING_GOAL_CONFIRMATION", confirmedAt: undefined, entityBindings: [{ schemaVersion: "1", reference: "NTU", entityType: "BENEFICIARY", entityId: "ben-ntu", resolutionMethod: "EXACT", confirmed: false }] });
    const getState = vi.fn(); const compile = vi.fn();
    await expect(new CompilationService(compilationRepository(unconfirmed), { getState } as never, { compile }).compile(unconfirmed.id, "trace")).rejects.toThrow("GOAL_NOT_CONFIRMED");
    expect(getState).not.toHaveBeenCalled(); expect(compile).not.toHaveBeenCalled();
  });

  it("rejects a persisted semantic hash mismatch before compiler invocation", async () => {
    const tampered = GoalContractV1.parse({ ...confirmedGoal(), goal: { type: "DELIVER_MONEY", amount: { currency: "USD", minorUnits: "50001" }, recipientId: "ben-ntu" } });
    const getState = vi.fn(); const compile = vi.fn();
    await expect(new CompilationService(compilationRepository(tampered), { getState } as never, { compile }).compile(tampered.id, "trace")).rejects.toThrow("GOAL_HASH_MISMATCH");
    expect(getState).not.toHaveBeenCalled(); expect(compile).not.toHaveBeenCalled();
  });
});
