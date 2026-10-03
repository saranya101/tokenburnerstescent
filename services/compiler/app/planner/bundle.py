"""Deterministic multi-goal compilation over the frozen bundle contract.

Items are compiled against an evolving simulated snapshot. Only explicit bundle
dependencies create cross-item plan dependencies; array order is used solely as
the deterministic tie-breaker between otherwise independent items.
"""

import hashlib
import json
from collections import deque
from decimal import Decimal

from app.constraints.evaluator import evaluate_constraints
from app.models.contracts import (
    AcquireAssetGroundedGoalV1,
    BankStateSnapshotV1,
    BundleItemCoverageV1,
    BundleSatisfactionProofV1,
    CompileGoalBundleResultV1,
    CompilerPolicyBlockedV1,
    CompilerReasonV1,
    CompilerUnsatV1,
    DeliverMoneyGroundedGoalV1,
    FinancialPlanV1,
    GoalBundleContractV1,
    GoalBundleItemV1,
    GoalContractV1,
    MoneyV1,
    MoveFundsGroundedGoalV1,
    PayBillGroundedGoalV1,
    PlanValidityV1,
    ProjectedOutcomeV1,
)
from app.operations.library import operation_sort_key
from app.operations.models import FxConvert, InternalOperation, Money, MoveFunds, Transfer
from app.planner.candidates import enumerate_candidates
from app.planner.compiler import (
    COMPILER_VERSION,
    OPERATION_LIBRARY_VERSION,
    POLICY_VERSION,
    compile_goal,
    step_parameters_for_operation,
)
from app.policy.engine import PolicyEngine
from app.simulator.apply import apply_operation
from app.simulator.state import SimulatedState

BundleCompileResult = CompileGoalBundleResultV1 | CompilerUnsatV1 | CompilerPolicyBlockedV1


def _canonical(value: object) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def _unsat(code: str, **details: object) -> CompilerUnsatV1:
    return CompilerUnsatV1(
        schemaVersion="1",
        status="UNSAT",
        reason=CompilerReasonV1(
            code=code, message=code.replace("_", " ").capitalize(), details=details or None
        ),
        relaxations=[],
    )


def _blocked(code: str, **details: object) -> CompilerPolicyBlockedV1:
    return CompilerPolicyBlockedV1(
        schemaVersion="1",
        status="POLICY_BLOCKED",
        reason=CompilerReasonV1(
            code=code, message=code.replace("_", " ").capitalize(), details=details or None
        ),
    )


def _ordered_items(bundle: GoalBundleContractV1) -> tuple[GoalBundleItemV1, ...]:
    """Stable topological order, retaining source array order between peers."""
    positions = {item.item_id: index for index, item in enumerate(bundle.items)}
    items = {item.item_id: item for item in bundle.items}
    indegree = {item.item_id: 0 for item in bundle.items}
    successors = {item.item_id: [] for item in bundle.items}
    for dependency in bundle.explicit_dependencies:
        indegree[dependency.after_item_id] += 1
        successors[dependency.before_item_id].append(dependency.after_item_id)
    ready = [item.item_id for item in bundle.items if indegree[item.item_id] == 0]
    ordered: list[GoalBundleItemV1] = []
    while ready:
        ready.sort(key=positions.__getitem__)
        item_id = ready.pop(0)
        ordered.append(items[item_id])
        for successor in successors[item_id]:
            indegree[successor] -= 1
            if indegree[successor] == 0:
                ready.append(successor)
    if len(ordered) != len(bundle.items):
        raise ValueError("Explicit dependency graph must be acyclic")
    return tuple(ordered)


def _goal_contract(
    bundle: GoalBundleContractV1,
    item: GoalBundleItemV1,
    snapshot: BankStateSnapshotV1,
) -> GoalContractV1:
    return GoalContractV1(
        schemaVersion="1",
        id=f"{bundle.bundle_id}:{item.item_id}",
        userId=snapshot.user_id,
        version=bundle.bundle_version,
        goal=item.goal,
        constraints=[*item.constraints, *bundle.global_constraints],
        preferences=item.preferences,
        entityBindings=item.bindings,
        status="CONFIRMED",
        contractHash=bundle.contract_hash,
        createdAt=snapshot.captured_at,
        confirmedAt=snapshot.captured_at,
    )


def _operation_from_step(step) -> InternalOperation:
    parameters = step.parameters
    if step.action == "TRANSFER":
        return Transfer(
            parameters.source_account_id,
            parameters.beneficiary_id,
            Money(parameters.amount.currency, int(parameters.amount.minor_units)),
        )
    if step.action == "MOVE_FUNDS":
        return MoveFunds(
            parameters.source_account_id,
            parameters.destination_account_id,
            Money(parameters.amount.currency, int(parameters.amount.minor_units)),
        )
    if step.action == "FX_CONVERT":
        return FxConvert(
            parameters.source_account_id,
            parameters.destination_account_id,
            Money(parameters.source_money.currency, int(parameters.source_money.minor_units)),
            parameters.target_currency,
            parameters.quote_id,
        )
    raise ValueError(f"Bundle compiler cannot compose {step.action} steps")


def _acquire_failure(
    item: GoalBundleItemV1, snapshot: BankStateSnapshotV1, policy: PolicyEngine
) -> CompilerUnsatV1 | CompilerPolicyBlockedV1:
    goal = item.goal
    assert isinstance(goal, AcquireAssetGroundedGoalV1)
    if goal.quantity is not None and Decimal(goal.quantity) <= 0:
        return _unsat("INVALID_QUANTITY", itemId=item.item_id, quantity=goal.quantity)
    if goal.budget is not None and int(goal.budget.minor_units) <= 0:
        return _unsat(
            "INVALID_AMOUNT",
            itemId=item.item_id,
            currency=goal.budget.currency,
            minorUnits=goal.budget.minor_units,
        )
    if "BUY_ASSET" not in policy.allowed_operations:
        return _blocked("OPERATION_NOT_ALLOWED", itemId=item.item_id, action="BUY_ASSET")
    asset = next(
        (candidate for candidate in snapshot.assets if candidate.id == goal.asset_id), None
    )
    if asset is None:
        return _unsat("ASSET_NOT_FOUND", itemId=item.item_id, assetId=goal.asset_id)
    if not asset.tradable:
        return _blocked("ASSET_NOT_TRADABLE", itemId=item.item_id, assetId=goal.asset_id)
    if not snapshot.service_availability.investments:
        return _blocked("REQUIRED_SERVICE_UNAVAILABLE", itemId=item.item_id, service="investments")
    eligible_accounts = [
        account
        for account in snapshot.accounts
        if account.status == "ACTIVE"
        and account.currency == asset.settlement_currency
        and "TRADE_ASSET" in account.capabilities
    ]
    if not eligible_accounts:
        return _unsat(
            "NO_ELIGIBLE_SETTLEMENT_ACCOUNT",
            itemId=item.item_id,
            assetId=goal.asset_id,
            settlementCurrency=asset.settlement_currency,
        )
    # BankStateSnapshotV1 contains asset identity and settlement currency, but no
    # authoritative price/market quote. BUY_ASSET requires an explicit total
    # price, so deriving quantity or cost here would invent financial data.
    return _unsat("ASSET_PRICE_UNAVAILABLE", itemId=item.item_id, assetId=goal.asset_id)


def _global_constraint_result(
    bundle: GoalBundleContractV1,
    initial: BankStateSnapshotV1,
    projected: SimulatedState,
    operations: tuple[InternalOperation, ...],
) -> CompilerUnsatV1 | None:
    if not bundle.global_constraints:
        return None
    synthetic = GoalContractV1(
        schemaVersion="1",
        id=bundle.bundle_id,
        userId=initial.user_id,
        version=bundle.bundle_version,
        goal=bundle.items[0].goal,
        constraints=bundle.global_constraints,
        preferences=[],
        entityBindings=[],
        status="CONFIRMED",
        contractHash=bundle.contract_hash,
        createdAt=initial.captured_at,
        confirmedAt=initial.captured_at,
    )
    evaluation = evaluate_constraints(synthetic, initial, projected, operations)
    if evaluation.valid:
        return None
    violation = evaluation.violations[0]
    return _unsat(violation.code, scope="GLOBAL", **violation.details)


def _bundle_plan_id(
    bundle: GoalBundleContractV1,
    snapshot: BankStateSnapshotV1,
    policy: PolicyEngine,
    operations: tuple[InternalOperation, ...],
) -> str:
    seed = {
        "goalBundle": bundle.model_dump(mode="json", by_alias=True),
        "state": snapshot.model_dump(mode="json", by_alias=True),
        "allowedOperations": sorted(policy.allowed_operations),
        "compilerVersion": COMPILER_VERSION,
        "route": [operation_sort_key(operation) for operation in operations],
    }
    return hashlib.sha256(_canonical(seed).encode()).hexdigest()[:32]


def _build_bundle_plan(
    bundle: GoalBundleContractV1,
    snapshot: BankStateSnapshotV1,
    projected: SimulatedState,
    policy: PolicyEngine,
    operations: tuple[InternalOperation, ...],
    item_ranges: dict[str, tuple[int, int]],
) -> tuple[FinancialPlanV1, BundleSatisfactionProofV1]:
    plan_id = _bundle_plan_id(bundle, snapshot, policy, operations)
    predecessors: dict[str, list[str]] = {item.item_id: [] for item in bundle.items}
    for dependency in bundle.explicit_dependencies:
        predecessors[dependency.after_item_id].append(dependency.before_item_id)

    step_payloads = []
    for item in _ordered_items(bundle):
        start, end = item_ranges[item.item_id]
        for index in range(start, end + 1):
            operation = operations[index]
            dependencies = [f"{plan_id}:{index - 1}"] if index > start else []
            if index == start:
                dependencies.extend(
                    f"{plan_id}:{item_ranges[predecessor][1]}"
                    for predecessor in predecessors[item.item_id]
                )
            step_payloads.append(
                {
                    "id": f"{plan_id}:{index}",
                    "sequence": index,
                    "action": operation.action,
                    "dependsOn": dependencies,
                    "reversible": operation.action == "MOVE_FUNDS",
                    "parameters": step_parameters_for_operation(operation),
                }
            )

    quote_ids = sorted(
        {operation.quote_id for operation in operations if isinstance(operation, FxConvert)}
    )
    expiries = [quote.expires_at for quote in snapshot.fx_quotes if quote.id in quote_ids]
    final = projected.to_snapshot()
    delivered_items = [
        item for item in bundle.items if isinstance(item.goal, DeliverMoneyGroundedGoalV1)
    ]
    outcome = ProjectedOutcomeV1(
        goalSatisfied=True,
        deliveredMoney=delivered_items[0].goal.amount if len(delivered_items) == 1 else None,
        acquiredAssets=[],
        paidObligationIds=[],
        projectedAvailableBalances=[
            {
                "accountId": account.id,
                "money": MoneyV1(
                    currency=account.currency, minorUnits=account.available_minor_units
                ).model_dump(mode="json", by_alias=True),
            }
            for account in sorted(final.accounts, key=lambda account: account.id)
        ],
        warnings=[],
    )
    payload = {
        "schemaVersion": "1",
        "id": plan_id,
        "goalContractId": bundle.bundle_id,
        "goalContractVersion": bundle.bundle_version,
        "bankStateVersion": snapshot.state_version,
        "compilerVersion": COMPILER_VERSION,
        "policyVersion": POLICY_VERSION,
        "operationLibraryVersion": OPERATION_LIBRARY_VERSION,
        "steps": step_payloads,
        "validity": PlanValidityV1(
            requiredQuoteIds=quote_ids, validUntil=min(expiries) if expiries else None
        ).model_dump(mode="json", by_alias=True, exclude_none=True),
        "projectedOutcome": outcome.model_dump(mode="json", by_alias=True, exclude_none=True),
    }
    payload["planHash"] = hashlib.sha256(_canonical(payload).encode()).hexdigest()
    plan = FinancialPlanV1.model_validate(payload)
    proof = BundleSatisfactionProofV1(
        schemaVersion="1",
        bundleId=bundle.bundle_id,
        bundleContractHash=bundle.contract_hash,
        itemCoverage=[
            BundleItemCoverageV1(
                itemId=item.item_id,
                satisfiedByStepIds=[f"{plan_id}:{item_ranges[item.item_id][1]}"],
            )
            for item in bundle.items
        ],
        allItemsSatisfied=True,
        allHardConstraintsSatisfied=True,
        allExplicitDependenciesSatisfied=True,
        allIrreversibleStepsJustified=True,
    )
    return plan, proof


def _step_satisfies_item(item: GoalBundleItemV1, step) -> bool:
    goal = item.goal
    parameters = step.parameters
    if isinstance(goal, DeliverMoneyGroundedGoalV1):
        return (
            step.action == "TRANSFER"
            and parameters.beneficiary_id == goal.recipient_id
            and parameters.amount == goal.amount
        )
    if isinstance(goal, MoveFundsGroundedGoalV1):
        return (
            step.action == "MOVE_FUNDS"
            and parameters.destination_account_id == goal.destination_account_id
            and parameters.amount == goal.amount
            and (
                goal.source_account_id is None
                or parameters.source_account_id == goal.source_account_id
            )
        )
    if isinstance(goal, AcquireAssetGroundedGoalV1):
        return (
            step.action == "BUY_ASSET"
            and parameters.asset_id == goal.asset_id
            and (goal.quantity is None or parameters.quantity == goal.quantity)
            and (goal.budget is None or parameters.maximum_spend == goal.budget)
        )
    if isinstance(goal, PayBillGroundedGoalV1):
        # V1 PAY_BILL identifies a biller, while PAY_BILL execution identifies an
        # obligation. No authoritative mapping exists in the compiler request.
        return False
    return False


def _ancestors(step_id: str, dependencies: dict[str, list[str]]) -> set[str]:
    seen: set[str] = set()
    queue = deque(dependencies.get(step_id, []))
    while queue:
        dependency = queue.popleft()
        if dependency in seen:
            continue
        seen.add(dependency)
        queue.extend(dependencies.get(dependency, []))
    return seen


def validate_bundle_plan(
    bundle: GoalBundleContractV1,
    plan: FinancialPlanV1,
    proof: BundleSatisfactionProofV1,
    initial_state: BankStateSnapshotV1,
) -> bool:
    """Independently prove coverage, constraints, dependencies and irreversibility."""
    if (
        proof.bundle_id != bundle.bundle_id
        or proof.bundle_contract_hash != bundle.contract_hash
        or not proof.all_items_satisfied
        or not proof.all_hard_constraints_satisfied
        or not proof.all_explicit_dependencies_satisfied
        or not proof.all_irreversible_steps_justified
    ):
        return False
    steps = {step.id: step for step in plan.steps}
    if len(steps) != len(plan.steps):
        return False
    if (
        plan.goal_contract_id != bundle.bundle_id
        or plan.goal_contract_version != bundle.bundle_version
        or plan.bank_state_version != initial_state.state_version
        or sorted(step.sequence for step in plan.steps) != list(range(len(plan.steps)))
        or any(step.reversible != (step.action == "MOVE_FUNDS") for step in plan.steps)
    ):
        return False
    plan_payload = plan.model_dump(mode="json", by_alias=True, exclude_none=True)
    supplied_plan_hash = plan_payload.pop("planHash")
    if hashlib.sha256(_canonical(plan_payload).encode()).hexdigest() != supplied_plan_hash:
        return False
    coverage = {entry.item_id: entry.satisfied_by_step_ids for entry in proof.item_coverage}
    if len(coverage) != len(proof.item_coverage):
        return False
    if set(coverage) != {item.item_id for item in bundle.items}:
        return False
    direct_steps: set[str] = set()
    for item in bundle.items:
        step_ids = coverage[item.item_id]
        if not step_ids or any(step_id not in steps for step_id in step_ids):
            return False
        if not all(_step_satisfies_item(item, steps[step_id]) for step_id in step_ids):
            return False
        direct_steps.update(step_ids)

    dependencies = {step.id: list(step.depends_on) for step in plan.steps}
    if any(dependency not in steps for values in dependencies.values() for dependency in values):
        return False
    for dependency in bundle.explicit_dependencies:
        before_steps = coverage[dependency.before_item_id]
        after_steps = coverage[dependency.after_item_id]
        if not all(
            before in _ancestors(after, dependencies)
            for before in before_steps
            for after in after_steps
        ):
            return False

    justified = set(direct_steps)
    for direct_id in direct_steps:
        direct = steps[direct_id]
        direct_source = getattr(direct.parameters, "source_account_id", None)
        for ancestor_id in _ancestors(direct_id, dependencies):
            ancestor = steps[ancestor_id]
            if (
                ancestor.action == "FX_CONVERT"
                and ancestor.parameters.destination_account_id == direct_source
            ):
                justified.add(ancestor_id)
    if any(not step.reversible and step.id not in justified for step in plan.steps):
        return False

    simulated = SimulatedState.from_snapshot(initial_state)
    operations: list[InternalOperation] = []
    completed_items: set[str] = set()
    item_by_id = {item.item_id: item for item in bundle.items}
    item_predecessors: dict[str, set[str]] = {item.item_id: set() for item in bundle.items}
    for dependency in bundle.explicit_dependencies:
        item_predecessors[dependency.after_item_id].add(dependency.before_item_id)
    coverage_owner = {
        step_id: item_id for item_id, step_ids in coverage.items() for step_id in step_ids
    }
    try:
        for step in sorted(plan.steps, key=lambda candidate: candidate.sequence):
            operation = _operation_from_step(step)
            active_items = [
                item
                for item in bundle.items
                if item.item_id not in completed_items
                and item_predecessors[item.item_id] <= completed_items
            ]
            if not any(
                operation
                in enumerate_candidates(
                    _goal_contract(bundle, item, simulated.to_snapshot()),
                    simulated.to_snapshot(),
                )
                for item in active_items
            ):
                return False
            result = apply_operation(simulated, operation)
            if not result.success:
                return False
            simulated = result.state
            operations.append(operation)
            owner = coverage_owner.get(step.id)
            if owner is not None:
                completed_items.add(item_by_id[owner].item_id)
    except (AttributeError, TypeError, ValueError):
        return False
    global_result = _global_constraint_result(bundle, initial_state, simulated, tuple(operations))
    return global_result is None


def compile_goal_bundle(
    bundle: GoalBundleContractV1,
    snapshot: BankStateSnapshotV1,
    policy: PolicyEngine | None = None,
) -> BundleCompileResult:
    policy = policy or PolicyEngine()
    state = SimulatedState.from_snapshot(snapshot)
    operations: list[InternalOperation] = []
    item_ranges: dict[str, tuple[int, int]] = {}
    for item in _ordered_items(bundle):
        if isinstance(item.goal, AcquireAssetGroundedGoalV1):
            return _acquire_failure(item, state.to_snapshot(), policy)
        if isinstance(item.goal, PayBillGroundedGoalV1):
            return _unsat("UNSUPPORTED_GOAL", itemId=item.item_id, goalType=item.goal.type)
        result = compile_goal(
            _goal_contract(bundle, item, snapshot), state.to_snapshot(), policy=policy
        )
        if result.status != "SAT":
            if result.reason.details is None:
                result.reason.details = {"itemId": item.item_id}
            else:
                result.reason.details.setdefault("itemId", item.item_id)
            return result
        start = len(operations)
        for step in result.plan.steps:
            operation = _operation_from_step(step)
            applied = apply_operation(state, operation)
            if not applied.success:
                return _unsat(
                    "COMPOSITE_SIMULATION_FAILED",
                    itemId=item.item_id,
                    violations=[violation.code for violation in applied.violations],
                )
            state = applied.state
            operations.append(operation)
        item_ranges[item.item_id] = (start, len(operations) - 1)

    combined = tuple(operations)
    global_failure = _global_constraint_result(bundle, snapshot, state, combined)
    if global_failure is not None:
        return global_failure
    plan, proof = _build_bundle_plan(bundle, snapshot, state, policy, combined, item_ranges)
    if not validate_bundle_plan(bundle, plan, proof, snapshot):
        return _unsat("BUNDLE_SATISFACTION_PROOF_FAILED")
    return CompileGoalBundleResultV1(financialPlan=plan, satisfactionProof=proof)
