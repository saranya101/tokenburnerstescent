"""Deterministic money-movement compiler; bill synthesis awaits target binding."""

import hashlib
import json
from dataclasses import dataclass

from app.constraints.cost import account_costs, account_costs_for_limit
from app.models.contracts import (
    BankStateSnapshotV1,
    CompilerPolicyBlockedV1,
    CompilerReasonV1,
    CompilerResultV1,
    CompilerSatV1,
    CompilerUnsatV1,
    DeliverMoneyGroundedGoalV1,
    FinancialPlanV1,
    GoalContractV1,
    HardRule,
    MoneyV1,
    MoveFundsGroundedGoalV1,
    PlanValidityV1,
    ProjectedOutcomeV1,
)
from app.operations.library import operation_sort_key
from app.operations.models import FxConvert, InternalOperation, MoveFunds, Transfer
from app.planner.search import SearchDiagnostics, SearchNode, search_routes
from app.policy.engine import PolicyEngine

COMPILER_VERSION = "c3b-1"
POLICY_VERSION = "c2-1"
OPERATION_LIBRARY_VERSION = "c1-1"


@dataclass(frozen=True)
class CompileOutcome:
    result: CompilerResultV1
    diagnostics: SearchDiagnostics | None


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


def _route_identity(node: SearchNode) -> tuple:
    return tuple(operation_sort_key(operation) for operation in node.operations)


def _material_identity(snapshot: BankStateSnapshotV1, node: SearchNode) -> tuple:
    """Financial consequences, excluding step IDs and harmless operation ordering."""
    costs = account_costs(snapshot, node.operations)
    fees = tuple(
        sorted(
            (entry.currency, entry.minor_units)
            for entry in costs.entries
            if entry.component == "FEE" and entry.minor_units
        )
    )
    external = tuple(
        sorted(
            (entry.currency, entry.minor_units, entry.action)
            for entry in costs.entries
            if entry.component == "EXTERNAL_SPEND"
        )
    )
    irreversible = tuple(
        sorted(
            operation.action for operation in node.operations if operation.action != "MOVE_FUNDS"
        )
    )
    expiries = tuple(
        sorted(
            quote.expires_at.isoformat()
            for quote in snapshot.fx_quotes
            if quote.id
            in {
                operation.quote_id
                for operation in node.operations
                if isinstance(operation, FxConvert)
            }
        )
    )
    return (node.state.digest(), node.completion, external, fees, irreversible, expiries)


def plans_materially_equivalent(
    snapshot: BankStateSnapshotV1, left: SearchNode, right: SearchNode
) -> bool:
    return _material_identity(snapshot, left) == _material_identity(snapshot, right)


def _cost_currency(
    goal: GoalContractV1, snapshot: BankStateSnapshotV1, solutions: tuple[SearchNode, ...]
) -> str | None:
    limits = [item.money.currency for item in goal.constraints if item.type == "MAX_TOTAL_COST"]
    if limits:
        return limits[0] if len(set(limits)) == 1 else None
    candidate_currencies = {
        entry.currency
        for node in solutions
        for entry in account_costs_for_limit(
            snapshot, node.operations, goal.goal.amount.currency
        ).entries
        if entry.minor_units
    }
    return (
        goal.goal.amount.currency if candidate_currencies <= {goal.goal.amount.currency} else None
    )


def _rank(
    goal: GoalContractV1, snapshot: BankStateSnapshotV1, solutions: tuple[SearchNode, ...]
) -> SearchNode | CompilerUnsatV1:
    unique = tuple(
        sorted({_route_identity(node): node for node in solutions}.values(), key=_route_identity)
    )
    if len(unique) == 1:
        return unique[0]
    if not goal.preferences:
        if len({_material_identity(snapshot, node) for node in unique}) > 1:
            return _unsat("AMBIGUOUS_VALID_PLANS", candidateCount=len(unique))
        return unique[0]
    currency = _cost_currency(goal, snapshot, unique)
    if any(item.type == "MINIMIZE_TOTAL_COST" for item in goal.preferences) and currency is None:
        return _unsat("COST_COMPARISON_UNAVAILABLE", candidateCount=len(unique))

    def preference_key(node: SearchNode) -> tuple:
        parts: list[int] = []
        for preference in goal.preferences:
            if preference.type == "MINIMIZE_TOTAL_COST":
                costs = account_costs_for_limit(snapshot, node.operations, currency)
                if (
                    costs.missing_quote_ids
                    or costs.foreign_currencies(currency)
                    or costs.invalid_operations
                ):
                    return (10**100,)
                parts.append(costs.total(currency))
            elif preference.type == "MINIMIZE_FX":
                parts.append(sum(isinstance(operation, FxConvert) for operation in node.operations))
            elif preference.type == "FASTEST":
                parts.append(len(node.operations))
            elif preference.type == "PREFER_ACCOUNT":
                parts.append(
                    0
                    if node.operations
                    and getattr(node.operations[0], "source_account_id", None)
                    == preference.account_id
                    else 1
                )
        return tuple(parts)

    if any(item.type == "MINIMIZE_TOTAL_COST" for item in goal.preferences):
        if any(
            (
                lambda cost: (
                    cost.missing_quote_ids
                    or cost.foreign_currencies(currency)
                    or cost.invalid_operations
                )
            )(account_costs_for_limit(snapshot, node.operations, currency))
            for node in unique
        ):
            return _unsat("COST_COMPARISON_UNAVAILABLE", candidateCount=len(unique))
    best_key = min(preference_key(node) for node in unique)
    finalists = tuple(node for node in unique if preference_key(node) == best_key)
    if len({_material_identity(snapshot, node) for node in finalists}) > 1:
        return _unsat("AMBIGUOUS_VALID_PLANS", candidateCount=len(finalists))
    return min(finalists, key=lambda node: (len(node.operations), _route_identity(node)))


def _money(money) -> dict[str, str]:
    return {"currency": money.currency, "minorUnits": str(money.minor_units)}


def _step_parameters(operation: InternalOperation) -> dict:
    if isinstance(operation, Transfer):
        return {
            "sourceAccountId": operation.source_account_id,
            "beneficiaryId": operation.beneficiary_id,
            "amount": _money(operation.amount),
        }
    if isinstance(operation, MoveFunds):
        return {
            "sourceAccountId": operation.source_account_id,
            "destinationAccountId": operation.destination_account_id,
            "amount": _money(operation.amount),
        }
    if isinstance(operation, FxConvert):
        return {
            "sourceAccountId": operation.source_account_id,
            "destinationAccountId": operation.destination_account_id,
            "sourceMoney": _money(operation.from_amount),
            "targetCurrency": operation.to_currency,
            "quoteId": operation.quote_id,
        }
    raise ValueError(f"Compiler cannot construct {operation.action} steps")


def plan_id_for_inputs(
    goal: GoalContractV1,
    snapshot: BankStateSnapshotV1,
    hard_rules: tuple[HardRule, ...],
    policy: PolicyEngine,
    operations: tuple[InternalOperation, ...],
    compiler_version: str = COMPILER_VERSION,
) -> str:
    """Commit to exact planning inputs, including quote economics and policy."""
    seed = {
        "goal": goal.model_dump(mode="json", by_alias=True),
        "state": snapshot.model_dump(mode="json", by_alias=True),
        "hardRules": sorted(
            (rule.model_dump(mode="json", by_alias=True) for rule in hard_rules), key=_canonical
        ),
        "allowedOperations": sorted(policy.allowed_operations),
        "compilerVersion": compiler_version,
        "route": [operation_sort_key(operation) for operation in operations],
    }
    return hashlib.sha256(_canonical(seed).encode()).hexdigest()[:32]


def _build_plan(
    goal: GoalContractV1,
    snapshot: BankStateSnapshotV1,
    hard_rules: tuple[HardRule, ...],
    policy: PolicyEngine,
    node: SearchNode,
) -> FinancialPlanV1:
    plan_id = plan_id_for_inputs(goal, snapshot, hard_rules, policy, node.operations)
    steps = []
    for index, operation in enumerate(node.operations):
        step_id = f"{plan_id}:{index}"
        steps.append(
            {
                "id": step_id,
                "sequence": index,
                "action": operation.action,
                "dependsOn": [f"{plan_id}:{index - 1}"] if index else [],
                "reversible": operation.action == "MOVE_FUNDS",
                "parameters": _step_parameters(operation),
            }
        )
    quote_ids = sorted(
        {operation.quote_id for operation in node.operations if isinstance(operation, FxConvert)}
    )
    expiries = [quote.expires_at for quote in snapshot.fx_quotes if quote.id in quote_ids]
    final = node.state.to_snapshot()
    outcome = ProjectedOutcomeV1(
        goalSatisfied=True,
        deliveredMoney=goal.goal.amount
        if isinstance(goal.goal, DeliverMoneyGroundedGoalV1)
        else None,
        acquiredAssets=[],
        paidObligationIds=[],
        projectedAvailableBalances=[
            {
                "accountId": account.id,
                "money": MoneyV1(
                    currency=account.currency, minorUnits=account.available_minor_units
                ).model_dump(mode="json", by_alias=True),
            }
            for account in sorted(final.accounts, key=lambda item: item.id)
        ],
        warnings=[],
    )
    payload = {
        "schemaVersion": "1",
        "id": plan_id,
        "goalContractId": goal.id,
        "goalContractVersion": goal.version,
        "bankStateVersion": snapshot.state_version,
        "compilerVersion": COMPILER_VERSION,
        "policyVersion": POLICY_VERSION,
        "operationLibraryVersion": OPERATION_LIBRARY_VERSION,
        "steps": steps,
        "validity": PlanValidityV1(
            requiredQuoteIds=quote_ids, validUntil=min(expiries) if expiries else None
        ).model_dump(mode="json", by_alias=True, exclude_none=True),
        "projectedOutcome": outcome.model_dump(mode="json", by_alias=True, exclude_none=True),
    }
    payload["planHash"] = hashlib.sha256(_canonical(payload).encode()).hexdigest()
    return FinancialPlanV1.model_validate(payload)


def _no_solution_reason(
    goal: GoalContractV1, snapshot: BankStateSnapshotV1, diagnostics: SearchDiagnostics
) -> CompilerResultV1:
    target = goal.goal
    if isinstance(target, DeliverMoneyGroundedGoalV1):
        beneficiary = next(
            (item for item in snapshot.beneficiaries if item.id == target.recipient_id), None
        )
        if beneficiary is not None and beneficiary.status != "ACTIVE":
            return _blocked(
                "BENEFICIARY_BLOCKED"
                if beneficiary.status == "BLOCKED"
                else "BENEFICIARY_UNVERIFIED",
                beneficiaryId=beneficiary.id,
            )
        if beneficiary is None:
            return _unsat("BENEFICIARY_NOT_ALLOWED", beneficiaryId=target.recipient_id)
    if not snapshot.service_availability.transfers:
        return _blocked("REQUIRED_SERVICE_UNAVAILABLE", service="transfers")
    for code in (
        "MIN_AVAILABLE_BALANCE_VIOLATED",
        "MAX_TOTAL_COST_VIOLATED",
        "EXCLUDED_ACCOUNT_USED",
    ):
        if any(item.code == code for item in diagnostics.constraint_violations):
            return _unsat(
                {
                    "MAX_TOTAL_COST_VIOLATED": "MAX_TOTAL_COST_TOO_LOW",
                    "EXCLUDED_ACCOUNT_USED": "EXCLUDED_ACCOUNT_PREVENTS_ROUTE",
                }.get(code, code)
            )
    if diagnostics.policy_violations:
        priority = (
            "BENEFICIARY_BLOCKED",
            "BENEFICIARY_UNVERIFIED",
            "ACCOUNT_FROZEN",
            "ACCOUNT_INACTIVE",
            "ACCOUNT_CAPABILITY_MISSING",
            "SERVICE_UNAVAILABLE",
            "OPERATION_NOT_ALLOWED",
        )
        for code in priority:
            if any(item.code == code for item in diagnostics.policy_violations):
                return _blocked(
                    "REQUIRED_SERVICE_UNAVAILABLE" if code == "SERVICE_UNAVAILABLE" else code
                )
    if isinstance(target, MoveFundsGroundedGoalV1):
        if not any(account.id == target.destination_account_id for account in snapshot.accounts):
            return _unsat("NO_ELIGIBLE_DESTINATION_ACCOUNT")
    if isinstance(target, DeliverMoneyGroundedGoalV1):
        matching_quotes = [
            quote for quote in snapshot.fx_quotes if quote.to_currency == target.amount.currency
        ]
        if matching_quotes and all(
            quote.expires_at <= snapshot.captured_at for quote in matching_quotes
        ):
            if not any(
                account.currency == target.amount.currency
                and min(int(account.available_minor_units), int(account.ledger_minor_units))
                >= int(target.amount.minor_units)
                for account in snapshot.accounts
            ):
                return _unsat("QUOTE_EXPIRED")
    if diagnostics.depth_limited:
        return _unsat("SEARCH_DEPTH_EXHAUSTED", maxDepth=diagnostics.search_depth_reached)
    if isinstance(target, DeliverMoneyGroundedGoalV1):
        currency = target.amount.currency
        active_sources = [
            account
            for account in snapshot.accounts
            if account.status == "ACTIVE" and "SEND_TRANSFER" in account.capabilities
        ]
        if not active_sources:
            return _unsat("NO_ELIGIBLE_SOURCE_ACCOUNT")
        funded_direct = any(
            account.currency == currency
            and min(int(account.available_minor_units), int(account.ledger_minor_units))
            >= int(target.amount.minor_units)
            for account in active_sources
        )
        valid_target_quote = any(
            quote.to_currency == currency and quote.expires_at > snapshot.captured_at
            for quote in snapshot.fx_quotes
        )
        if not funded_direct:
            if not valid_target_quote and any(
                account.currency != currency and int(account.available_minor_units) > 0
                for account in active_sources
            ):
                return _unsat("NO_FX_ROUTE")
            if (
                valid_target_quote
                and any(
                    account.currency != currency and int(account.available_minor_units) > 0
                    for account in active_sources
                )
                and not any(
                    account.currency == currency
                    and account.status == "ACTIVE"
                    and "RECEIVE_TRANSFER" in account.capabilities
                    for account in snapshot.accounts
                )
            ):
                return _unsat("NO_ELIGIBLE_DESTINATION_ACCOUNT")
            if valid_target_quote or any(
                account.currency == currency for account in active_sources
            ):
                return _unsat("INSUFFICIENT_FUNDS")
    if any(item.code == "INSUFFICIENT_FUNDS" for item in diagnostics.operation_violations):
        return _unsat("INSUFFICIENT_FUNDS")
    return _unsat(
        "NO_TRANSFER_ROUTE"
        if isinstance(target, DeliverMoneyGroundedGoalV1)
        else "INSUFFICIENT_FUNDS"
    )


def compile_with_diagnostics(
    goal: GoalContractV1,
    snapshot: BankStateSnapshotV1,
    hard_rules: tuple[HardRule, ...] = (),
    policy: PolicyEngine | None = None,
    max_depth: int = 4,
    max_states: int = 1000,
) -> CompileOutcome:
    if goal.status != "CONFIRMED":
        return CompileOutcome(_unsat("GOAL_NOT_CONFIRMED"), None)
    if goal.user_id != snapshot.user_id:
        return CompileOutcome(_unsat("STATE_USER_MISMATCH"), None)
    if not isinstance(goal.goal, (DeliverMoneyGroundedGoalV1, MoveFundsGroundedGoalV1)):
        return CompileOutcome(_unsat("UNSUPPORTED_GOAL", goalType=goal.goal.type), None)
    if int(goal.goal.amount.minor_units) <= 0:
        return CompileOutcome(_unsat("INVALID_AMOUNT"), None)
    if any(rule.enabled and rule.user_id != goal.user_id for rule in hard_rules):
        return CompileOutcome(_unsat("HARD_RULE_USER_MISMATCH"), None)
    policy = policy or PolicyEngine()
    search = search_routes(goal, snapshot, hard_rules, policy, max_depth, max_states)
    if search.diagnostics.states_limited:
        return CompileOutcome(
            _unsat("MAX_STATES_EXPLORED", maxStates=max_states), search.diagnostics
        )
    if not search.solutions:
        return CompileOutcome(
            _no_solution_reason(goal, snapshot, search.diagnostics), search.diagnostics
        )
    winner = _rank(goal, snapshot, search.solutions)
    if isinstance(winner, CompilerUnsatV1):
        return CompileOutcome(winner, search.diagnostics)
    plan = _build_plan(goal, snapshot, hard_rules, policy, winner)
    return CompileOutcome(
        CompilerSatV1(schemaVersion="1", status="SAT", plan=plan), search.diagnostics
    )


def compile_goal(
    goal: GoalContractV1,
    snapshot: BankStateSnapshotV1,
    hard_rules: tuple[HardRule, ...] = (),
    policy: PolicyEngine | None = None,
    max_depth: int = 4,
    max_states: int = 1000,
) -> CompilerResultV1:
    return compile_with_diagnostics(
        goal, snapshot, hard_rules, policy, max_depth, max_states
    ).result
