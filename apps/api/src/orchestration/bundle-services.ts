import { randomUUID } from "node:crypto";
import {
  GoalBundleContractV1, GoalBundleItemV1, IntentBundleDraftV1,
  type ConstraintV1, type GoalBundleContractV1 as GoalBundleContract, type IntentBundleDraftV1 as IntentBundleDraft,
} from "@parlance/contracts";
import { hashGoalBundleContract } from "@parlance/contracts/server";
import {
  DeterministicGoalContractBuilder, DeterministicIntentBundleAmbiguityDetector, DeterministicIntentBundleCoverageValidator,
  DeterministicReadOnlyIntentValidator, GoalContractCandidateV1, groundingRequirementsForIntentBundle, intentDraftForBundleItem,
  replaceClarifiedIntentBundleItem,
  type ClarificationItem, type EntityGrounder, type EntityGroundingResult, type GoalContractBuilder,
  type GroundableEntityType, type IndependentIntentValidationResult, type IndependentIntentValidator,
  type IntentBundleAmbiguityDetector, type IntentBundleInterpreter, type IntentBundleItemGroundingResults,
} from "@parlance/intent-engine";
import { z } from "zod";
import type {
  BundleClarificationAnswer, BundleConfirmationRepository, GoalBundleCandidate, SemanticValidationEvidence,
  StoredBundleClarification,
} from "./ports.js";
import { ConversationalMessageInput, inputProvenance, type ConversationalInputProvenance } from "./input-provenance.js";

const ClarificationAnswerInput = z.union([
  z.object({ selectedCandidateId: z.string().min(1) }).strict(),
  z.object({ answerText: z.string().trim().min(1) }).strict(),
]);

export type BundleEntityGrounderFactory = (userId: string) => EntityGrounder;

export function isPotentialBundleRequest(text: string): boolean {
  const actions = text.match(/\b(?:send(?:ing)?|deliver(?:ing)?|remit(?:ting)?|wire|transfer(?:ring)?|buy(?:ing)?|acquir(?:e|ing)|purchas(?:e|ing)|invest(?:ing)?\s+in|pay(?:ing)?|settl(?:e|ing)|mov(?:e|ing))\b/giu) ?? [];
  return actions.length > 1;
}

export class BundleMessageOrchestrationService {
  constructor(
    private readonly repository: BundleConfirmationRepository,
    private readonly interpreter: IntentBundleInterpreter,
    private readonly grounderForUser: BundleEntityGrounderFactory,
    private readonly ambiguityDetector: IntentBundleAmbiguityDetector = new DeterministicIntentBundleAmbiguityDetector(),
    private readonly goalBuilder: GoalContractBuilder = new DeterministicGoalContractBuilder(),
    private readonly coverageValidator = new DeterministicIntentBundleCoverageValidator(),
    private readonly itemValidator: IndependentIntentValidator = new DeterministicReadOnlyIntentValidator(),
    private readonly now: () => Date = () => new Date(),
    private readonly newId: () => string = randomUUID,
  ) {}

  handles(text: string): boolean { return isPotentialBundleRequest(text); }

  async receive(value: unknown, traceId: string) {
    const input = ConversationalMessageInput.parse(value);
    const provenance = inputProvenance(input);
    const intentBundle = IntentBundleDraftV1.parse(await this.interpreter.interpretUserRequest(input));
    const coverage = this.coverageValidator.validate({ sourceText: input.text, bundle: intentBundle });
    const createdAt = this.now().toISOString(); const recordId = this.newId();
    if (coverage.status === "FAIL") {
      await this.repository.rejectBundleSemanticValidation({ recordId, userId: input.userId, schemaVersion: "1", createdAt, originalText: input.text, inputProvenance: provenance, validation: evidence(coverage, provenance), traceId });
      return semanticValidationFailed();
    }
    const grounding = await groundBundle(intentBundle, this.grounderForUser(input.userId));
    const ambiguity = this.ambiguityDetector.analyze({ bundle: intentBundle, ...grounding });
    const bundleId = this.newId();
    if (ambiguity.status === "NEEDS_CLARIFICATION") {
      const clarifications = bundleClarifications(ambiguity);
      const stored = await this.repository.saveBundleClarification({
        clarificationId: recordId, bundleId, userId: input.userId, version: 1, createdAt, originalText: input.text,
        intentBundle, ...grounding, clarifications, clarificationAnswers: [], inputProvenance: provenance, traceId,
      });
      return bundleClarificationResponse(stored);
    }
    const candidate = buildCandidate(intentBundle, grounding.itemGroundingResults, grounding.globalGroundingResults, this.goalBuilder);
    const validation = validateCandidate(input.text, intentBundle, candidate, [], this.coverageValidator, this.itemValidator);
    if (validation.status === "FAIL") {
      await this.repository.rejectBundleSemanticValidation({ recordId, userId: input.userId, schemaVersion: "1", createdAt, originalText: input.text, inputProvenance: provenance, validation: evidence(validation, provenance), traceId });
      return semanticValidationFailed();
    }
    const stored = await this.repository.saveBundleCandidate({
      candidateId: recordId, bundleId, userId: input.userId, version: 1, createdAt, originalText: input.text,
      intentBundle, candidate, clarificationAnswers: [], inputProvenance: provenance, semanticValidation: evidence(validation, provenance), traceId,
    });
    return bundleCandidateResponse(stored);
  }

  async answerClarification(clarificationId: string, value: unknown, traceId: string) {
    const answer = ClarificationAnswerInput.parse(value);
    const pending = await this.repository.getBundleClarification(clarificationId);
    if (pending === null) {
      const completed = await this.repository.getBundleCandidate(clarificationId);
      if (completed !== null) return bundleCandidateResponse(completed);
      throw new Error("BUNDLE_CLARIFICATION_NOT_FOUND");
    }
    const clarification = pending.clarifications[0];
    if (clarification === undefined) throw new Error("BUNDLE_CLARIFICATION_NOT_ANSWERABLE");
    const requirement = groundingRequirementsForIntentBundle(pending.intentBundle).find((item) => item.field === clarification.field && item.reference === clarification.originalReference);
    if (requirement === undefined) throw new Error("BUNDLE_CLARIFICATION_REQUIREMENT_NOT_FOUND");
    const answerText = "selectedCandidateId" in answer
      ? clarification.options.find((option) => option.entityId === answer.selectedCandidateId)?.displayName ?? answer.selectedCandidateId
      : answer.answerText;
    const resolved = "selectedCandidateId" in answer
      ? selectedGrounding(clarification, answer.selectedCandidateId, requirement.expectedEntityType, answerText)
      : rebaseGrounding(await this.grounderForUser(pending.userId).ground(requirement.expectedEntityType === undefined
        ? { reference: answer.answerText }
        : { reference: answer.answerText, expectedEntityType: requirement.expectedEntityType }), answerText, requirement.expectedEntityType);
    const intentBundle = updateClarifiedBundle(pending.intentBundle, requirement.field, answerText);
    const grounding = replaceBundleGrounding(pending, requirement.scope, requirement.scope === "ITEM" ? requirement.itemId : undefined, clarification.originalReference, resolved);
    const ambiguity = this.ambiguityDetector.analyze({ bundle: intentBundle, ...grounding });
    const clarificationAnswers = [...pending.clarificationAnswers, { field: requirement.field, originalReference: clarification.originalReference, answer: answerText }];
    const provenance = pending.inputProvenance ?? { inputMode: "TYPED" as const, submittedText: pending.originalText, edited: false as const };
    const candidate = ambiguity.status === "CLEAR" ? buildCandidate(intentBundle, grounding.itemGroundingResults, grounding.globalGroundingResults, this.goalBuilder) : undefined;
    const validation = candidate === undefined ? undefined : validateCandidate(pending.originalText, intentBundle, candidate, clarificationAnswers, this.coverageValidator, this.itemValidator);
    if (validation?.status === "FAIL") {
      await this.repository.rejectBundleSemanticValidation({ recordId: clarificationId, userId: pending.userId, schemaVersion: "1", createdAt: pending.createdAt, originalText: pending.originalText, inputProvenance: provenance, answerText, validation: evidence(validation, provenance, clarificationAnswers.map(({ answer }) => answer)), traceId });
      return semanticValidationFailed();
    }
    const progress = await this.repository.advanceBundleClarification({
      ...pending, intentBundle, ...grounding, clarificationAnswers, answerText, traceId,
      clarifications: ambiguity.status === "CLEAR" ? [] : bundleClarifications(ambiguity),
      ...(candidate === undefined ? {} : { candidate, semanticValidation: evidence(validation!, provenance, clarificationAnswers.map(({ answer }) => answer)) }),
    });
    return progress.status === "AWAITING_BUNDLE_CONFIRMATION" ? bundleCandidateResponse(progress.candidate) : bundleClarificationResponse(progress.request);
  }

  async confirm(candidateId: string, traceId: string) {
    const stored = await this.repository.getBundleCandidate(candidateId);
    if (!stored) throw new Error("GOAL_BUNDLE_CANDIDATE_NOT_FOUND");
    const confirmedAt = this.now().toISOString();
    const unhashed = GoalBundleContractV1.parse({
      schemaVersion: "1", bundleId: stored.bundleId, bundleVersion: stored.version,
      items: stored.candidate.items.map((item) => ({ ...item, bindings: item.bindings.map((binding) => ({ ...binding, confirmed: true })) })),
      globalConstraints: stored.candidate.globalConstraints, explicitDependencies: stored.candidate.explicitDependencies,
      contractHash: "0".repeat(64),
    });
    const contract = GoalBundleContractV1.parse({ ...unhashed, contractHash: hashGoalBundleContract(unhashed) });
    const confirmed = await this.repository.confirmGoalBundle({ candidateId, userId: stored.userId, contract, confirmedAt, traceId });
    return { status: "CONFIRMED" as const, goalBundleContract: confirmed.contract };
  }
}

async function groundBundle(bundle: IntentBundleDraft, grounder: EntityGrounder) {
  const requirements = groundingRequirementsForIntentBundle(bundle);
  const grounded = await Promise.all(requirements.map(async (requirement) => ({ requirement, result: await grounder.ground(requirement.expectedEntityType === undefined
    ? { reference: requirement.reference }
    : { reference: requirement.reference, expectedEntityType: requirement.expectedEntityType }) })));
  const itemGroundingResults: IntentBundleItemGroundingResults[] = bundle.items.map((item) => ({
    itemId: item.itemId,
    groundingResults: grounded.filter(({ requirement }) => requirement.scope === "ITEM" && requirement.itemId === item.itemId).map(({ result }) => result),
  }));
  const globalGroundingResults = grounded.filter(({ requirement }) => requirement.scope === "GLOBAL").map(({ result }) => result);
  return { itemGroundingResults, globalGroundingResults };
}

function buildCandidate(bundle: IntentBundleDraft, itemResults: readonly IntentBundleItemGroundingResults[], globalResults: readonly EntityGroundingResult[], builder: GoalContractBuilder): GoalBundleCandidate {
  return {
    schemaVersion: "1",
    items: bundle.items.map((item) => {
      const candidate = GoalContractCandidateV1.parse(builder.build({ draft: intentDraftForBundleItem(item), groundingResults: itemResults.find((entry) => entry.itemId === item.itemId)?.groundingResults ?? [] }));
      return GoalBundleItemV1.parse({ itemId: item.itemId, goal: candidate.goal, constraints: candidate.constraints, preferences: candidate.preferences, bindings: candidate.entityBindings });
    }),
    globalConstraints: groundGlobalConstraints(bundle, globalResults),
    explicitDependencies: bundle.explicitDependencies,
  };
}

function groundGlobalConstraints(bundle: IntentBundleDraft, results: readonly EntityGroundingResult[]): ConstraintV1[] {
  return bundle.globalConstraints.map((constraint) => {
    if (constraint.type === "MIN_AVAILABLE_BALANCE" && constraint.accountReference !== undefined) {
      return { type: constraint.type, money: constraint.money, accountId: requiredEntityId(results, constraint.accountReference, "ACCOUNT") };
    }
    if (constraint.type === "EXCLUDED_ACCOUNT") return { type: constraint.type, accountId: requiredEntityId(results, constraint.accountReference, "ACCOUNT") };
    return constraint;
  });
}

function requiredEntityId(results: readonly EntityGroundingResult[], reference: string, entityType: GroundableEntityType): string {
  const result = results.find((item) => item.reference === reference && item.status === "RESOLVED" && item.entityType === entityType);
  if (!result || result.status !== "RESOLVED") throw new Error("BUNDLE_GLOBAL_BINDING_MISSING");
  return result.entityId;
}

function validateCandidate(sourceText: string, bundle: IntentBundleDraft, candidate: GoalBundleCandidate, answers: readonly BundleClarificationAnswer[], coverageValidator: DeterministicIntentBundleCoverageValidator, itemValidator: IndependentIntentValidator): IndependentIntentValidationResult {
  const mismatches = [...coverageValidator.validate({ sourceText, bundle }).mismatches];
  const actualEvidence = [sourceText, ...answers.map(({ answer }) => answer)].join("\n");
  const globalBindings = globalConstraintBindings(bundle, candidate, answers);
  bundle.items.forEach((item, index) => {
    const grounded = candidate.items[index]; if (!grounded) return;
    const draft = { ...intentDraftForBundleItem(item), originalText: actualEvidence, constraints: [...item.constraints, ...bundle.globalConstraints] };
    const validationCandidate = GoalContractCandidateV1.parse({
      schemaVersion: "1", goal: grounded.goal, constraints: [...grounded.constraints, ...candidate.globalConstraints], preferences: grounded.preferences,
      entityBindings: [...grounded.bindings, ...globalBindings],
    });
    const result = itemValidator.validate({ sourceText: actualEvidence, draft, candidate: validationCandidate });
    // Bundle coverage is authoritative for multi-clause action verbs, including Person B's
    // supported gerunds ("sending"/"buying") that the legacy single-intent evidence matcher lacks.
    mismatches.push(...result.mismatches.filter(({ code }) => code !== "GOAL_TYPE_NOT_SUPPORTED_BY_SOURCE").map((mismatch) => ({ ...mismatch, field: `items[${index}].${mismatch.field}` })));
  });
  return mismatches.length === 0 ? { status: "PASS", mismatches: [] } : { status: "FAIL", mismatches };
}

function globalConstraintBindings(bundle: IntentBundleDraft, candidate: GoalBundleCandidate, answers: readonly BundleClarificationAnswer[]) {
  const evidence = new Map(answers.map((answer) => [answer.field, answer.answer]));
  return bundle.globalConstraints.flatMap((constraint, index) => {
    const grounded = candidate.globalConstraints[index];
    if (constraint.type === "MIN_AVAILABLE_BALANCE" && constraint.accountReference !== undefined && grounded?.type === "MIN_AVAILABLE_BALANCE" && grounded.accountId !== undefined) {
      return [{ schemaVersion: "1" as const, reference: evidence.get(`globalConstraints[${index}].accountReference`) ?? constraint.accountReference, entityType: "ACCOUNT" as const, entityId: grounded.accountId, resolutionMethod: "USER_CONFIRMED" as const, confirmed: false }];
    }
    if (constraint.type === "EXCLUDED_ACCOUNT" && grounded?.type === "EXCLUDED_ACCOUNT") {
      return [{ schemaVersion: "1" as const, reference: evidence.get(`globalConstraints[${index}].accountReference`) ?? constraint.accountReference, entityType: "ACCOUNT" as const, entityId: grounded.accountId, resolutionMethod: "USER_CONFIRMED" as const, confirmed: false }];
    }
    return [];
  });
}

function bundleClarifications(result: Exclude<ReturnType<IntentBundleAmbiguityDetector["analyze"]>, { status: "CLEAR" }>): ClarificationItem[] {
  return [...result.items.flatMap((item) => item.status === "NEEDS_CLARIFICATION" ? item.clarifications : []), ...result.globalClarifications];
}

function updateClarifiedBundle(bundle: IntentBundleDraft, field: string, answer: string): IntentBundleDraft {
  const itemMatch = /^items\[(\d+)\]\.(.+)$/u.exec(field);
  if (itemMatch) {
    const index = Number(itemMatch[1]); const relative = itemMatch[2]; const item = bundle.items[index];
    if (!item || !relative) throw new Error("BUNDLE_CLARIFICATION_FIELD_INVALID");
    const replacement = structuredClone(item) as unknown as Record<string, unknown>; setPath(replacement, relative, answer);
    delete replacement.itemId;
    return replaceClarifiedIntentBundleItem(bundle, item.itemId, replacement);
  }
  const globalMatch = /^globalConstraints\[(\d+)\]\.accountReference$/u.exec(field);
  if (!globalMatch) throw new Error("BUNDLE_CLARIFICATION_FIELD_INVALID");
  const index = Number(globalMatch[1]);
  return IntentBundleDraftV1.parse({ ...bundle, globalConstraints: bundle.globalConstraints.map((constraint, itemIndex) => itemIndex === index ? { ...constraint, accountReference: answer } : constraint) });
}

function setPath(target: Record<string, unknown>, path: string, value: string): void {
  const parts = path.split("."); let current = target;
  parts.forEach((part, index) => {
    if (index === parts.length - 1) { current[part] = value; return; }
    const next = current[part]; if (typeof next !== "object" || next === null || Array.isArray(next)) throw new Error("BUNDLE_CLARIFICATION_FIELD_INVALID");
    current = next as Record<string, unknown>;
  });
}

function replaceBundleGrounding(pending: StoredBundleClarification, scope: "ITEM" | "GLOBAL", itemId: string | undefined, reference: string, replacement: EntityGroundingResult) {
  if (scope === "GLOBAL") return { itemGroundingResults: pending.itemGroundingResults, globalGroundingResults: replaceGrounding(pending.globalGroundingResults, reference, replacement) };
  return {
    globalGroundingResults: pending.globalGroundingResults,
    itemGroundingResults: pending.itemGroundingResults.map((entry) => entry.itemId === itemId ? { ...entry, groundingResults: replaceGrounding(entry.groundingResults, reference, replacement) } : entry),
  };
}

function replaceGrounding(results: readonly EntityGroundingResult[], reference: string, replacement: EntityGroundingResult): EntityGroundingResult[] {
  let replaced = false;
  const next = results.map((result) => { if (!replaced && result.reference === reference) { replaced = true; return replacement; } return result; });
  if (!replaced) next.push(replacement); return next;
}

function selectedGrounding(clarification: ClarificationItem, entityId: string, expected: GroundableEntityType | undefined, reference: string): EntityGroundingResult {
  const option = clarification.options.find((item) => item.entityId === entityId && (expected === undefined || item.entityType === expected));
  if (!option) throw new Error("CLARIFICATION_OPTION_INVALID");
  return { status: "RESOLVED", reference, entityType: option.entityType, entityId: option.entityId, resolutionMethod: "USER_CONFIRMED" };
}

function rebaseGrounding(result: EntityGroundingResult, reference: string, expected: GroundableEntityType | undefined): EntityGroundingResult {
  if (result.status === "RESOLVED" && (expected === undefined || result.entityType === expected)) return { ...result, reference, resolutionMethod: "USER_CONFIRMED" };
  if (result.status === "AMBIGUOUS" || result.status === "CANDIDATES") return { ...result, reference, ...(expected === undefined ? {} : { expectedEntityType: expected }) };
  return expected === undefined ? { status: "NOT_FOUND", reference } : { status: "NOT_FOUND", reference, expectedEntityType: expected };
}

function evidence(result: IndependentIntentValidationResult, input: ConversationalInputProvenance, clarificationAnswers: readonly string[] = []): SemanticValidationEvidence {
  return { decision: result.status, mismatches: result.mismatches.map(({ code, field }) => ({ code, field })), input, clarificationAnswers };
}
function semanticValidationFailed() { return { status: "SEMANTIC_VALIDATION_FAILED" as const, message: "We couldn't safely verify that we understood your request. Please clarify or rephrase it." }; }
function bundleCandidateResponse(stored: { candidateId: string; candidate: GoalBundleCandidate }) { return { status: "AWAITING_BUNDLE_CONFIRMATION" as const, candidateId: stored.candidateId, goalBundleCandidate: stored.candidate }; }
function bundleClarificationResponse(stored: StoredBundleClarification) { return { status: "NEEDS_BUNDLE_CLARIFICATION" as const, clarificationId: stored.clarificationId, clarifications: stored.clarifications }; }

export function authoritativeBundleHash(contract: GoalBundleContract): string { return hashGoalBundleContract(contract); }
