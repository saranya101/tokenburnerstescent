import {
  CompileGoalBundleRequestV1, CompileGoalBundleResultV1, GoalBundleContractV1,
  type BundleSatisfactionProofV1, type FinancialPlanV1, type GoalBundleContractV1 as GoalBundleContract,
} from "@parlance/contracts";
import { hashGoalBundleContract } from "@parlance/contracts/server";
import { hashFinancialPlan } from "../security/canonical-hash.js";
import type { BankPort, BundleCompilerResult, BundlePlanRepository, CompilerPort, ParlanceRepository } from "./ports.js";

export class BundleCompilationService {
  constructor(private readonly repository: ParlanceRepository & BundlePlanRepository, private readonly bank: BankPort, private readonly compiler: CompilerPort) {}

  async compile(bundleId: string, traceId: string): Promise<BundleCompilerResult> {
    const stored = await this.repository.getConfirmedGoalBundle(bundleId);
    if (!stored) throw new Error("CONFIRMED_GOAL_BUNDLE_NOT_FOUND");
    const contract = GoalBundleContractV1.parse(stored.contract);
    if (hashGoalBundleContract(contract) !== contract.contractHash) throw new Error("GOAL_BUNDLE_HASH_MISMATCH");
    if (contract.items.some((item) => item.bindings.some((binding) => !binding.confirmed))) throw new Error("GOAL_BUNDLE_BINDING_NOT_CONFIRMED");
    if (!this.compiler.compileBundle) throw new Error("BUNDLE_COMPILER_UNAVAILABLE");
    const snapshot = await this.bank.getState(stored.userId, traceId);
    await this.repository.saveSnapshot(snapshot, traceId);
    const request = CompileGoalBundleRequestV1.parse({ goalBundle: contract, bankState: snapshot });
    const result = await this.compiler.compileBundle(request, traceId);
    if ("status" in result) {
      await this.repository.saveBundleCompilationFailure(stored.rowId, result, traceId);
      return result;
    }
    const parsed = CompileGoalBundleResultV1.parse(result);
    verifyBundleCompilerResult(contract, snapshot.stateVersion, parsed.financialPlan, parsed.satisfactionProof);
    const plan = { ...parsed.financialPlan, planHash: hashFinancialPlan(parsed.financialPlan) };
    await this.repository.saveBundlePlan(stored.rowId, plan, parsed.satisfactionProof, traceId);
    return { ...parsed, financialPlan: plan };
  }
}

export function verifyBundleCompilerResult(bundle: GoalBundleContract, stateVersion: number, plan: FinancialPlanV1, proof: BundleSatisfactionProofV1): void {
  if (plan.goalContractId !== bundle.bundleId || plan.goalContractVersion !== bundle.bundleVersion || plan.bankStateVersion !== stateVersion) throw new Error("BUNDLE_COMPILER_RESULT_BINDING_MISMATCH");
  if (proof.bundleId !== bundle.bundleId || proof.bundleContractHash !== bundle.contractHash) throw new Error("BUNDLE_SATISFACTION_PROOF_BINDING_MISMATCH");
  if (!proof.allItemsSatisfied) throw new Error("BUNDLE_ITEMS_NOT_SATISFIED");
  if (!proof.allHardConstraintsSatisfied) throw new Error("BUNDLE_HARD_CONSTRAINTS_NOT_SATISFIED");
  if (!proof.allExplicitDependenciesSatisfied) throw new Error("BUNDLE_DEPENDENCIES_NOT_SATISFIED");
  if (!proof.allIrreversibleStepsJustified) throw new Error("BUNDLE_IRREVERSIBLE_STEPS_NOT_JUSTIFIED");

  const expectedItems = new Set(bundle.items.map(({ itemId }) => itemId));
  const coverageItems = new Set<string>(); const stepIds = new Set(plan.steps.map(({ id }) => id));
  const coverageByItem = new Map<string, string[]>();
  for (const coverage of proof.itemCoverage) {
    if (!expectedItems.has(coverage.itemId)) throw new Error("BUNDLE_PROOF_UNKNOWN_ITEM");
    if (coverageItems.has(coverage.itemId)) throw new Error("BUNDLE_PROOF_DUPLICATE_ITEM");
    if (coverage.satisfiedByStepIds.length === 0) throw new Error("BUNDLE_PROOF_MISSING_ITEM_COVERAGE");
    coverageItems.add(coverage.itemId); coverageByItem.set(coverage.itemId, coverage.satisfiedByStepIds);
    const seenSteps = new Set<string>();
    for (const stepId of coverage.satisfiedByStepIds) {
      if (!stepIds.has(stepId)) throw new Error("BUNDLE_PROOF_UNKNOWN_STEP");
      if (seenSteps.has(stepId)) throw new Error("BUNDLE_PROOF_DUPLICATE_STEP");
      seenSteps.add(stepId);
    }
  }
  if (coverageItems.size !== expectedItems.size || [...expectedItems].some((itemId) => !coverageItems.has(itemId))) throw new Error("BUNDLE_PROOF_MISSING_ITEM_COVERAGE");

  const coveredSteps = new Set(proof.itemCoverage.flatMap(({ satisfiedByStepIds }) => satisfiedByStepIds));
  if (plan.steps.some((step) => !step.reversible && !coveredSteps.has(step.id))) throw new Error("BUNDLE_PROOF_UNJUSTIFIED_IRREVERSIBLE_STEP");
  const sequence = new Map(plan.steps.map((step) => [step.id, step.sequence]));
  const predecessors = new Map(plan.steps.map((step) => [step.id, step.dependsOn]));
  for (const dependency of bundle.explicitDependencies) {
    const before = coverageByItem.get(dependency.beforeItemId) ?? []; const after = coverageByItem.get(dependency.afterItemId) ?? [];
    const beforeTerminal = before.reduce((selected, stepId) => (sequence.get(stepId) ?? -1) > (sequence.get(selected) ?? -1) ? stepId : selected, before[0]!);
    for (const afterStep of after) {
      if ((sequence.get(beforeTerminal) ?? Number.MAX_SAFE_INTEGER) >= (sequence.get(afterStep) ?? -1) || !transitivelyDependsOn(afterStep, beforeTerminal, predecessors)) throw new Error("BUNDLE_PROOF_DEPENDENCY_MISMATCH");
    }
  }
}

function transitivelyDependsOn(stepId: string, required: string, predecessors: ReadonlyMap<string, readonly string[]>): boolean {
  const pending = [...(predecessors.get(stepId) ?? [])]; const visited = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop()!; if (current === required) return true;
    if (visited.has(current)) continue; visited.add(current); pending.push(...(predecessors.get(current) ?? []));
  }
  return false;
}
