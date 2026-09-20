import hashlib
import json
from uuid import NAMESPACE_URL, uuid5

from app.models.contracts import (
    BankStateSnapshotV1,
    CompilerReasonV1,
    CompilerResultV1,
    CompilerSatV1,
    CompilerUnsatV1,
    DeliverMoneyGoalV1,
    FinancialPlanV1,
    GoalContractV1,
    MinAvailableBalanceV1,
    MoneyV1,
    PlanValidityV1,
    ProjectedOutcomeV1,
    TransferPlanStepV1,
)

COMPILER_VERSION = "scaffold-0.2-contract-v1"


def compile_goal(goal: GoalContractV1, snapshot: BankStateSnapshotV1) -> CompilerResultV1:
    """A deliberately narrow deterministic example, not a production planner."""
    if goal.status != "CONFIRMED":
        return CompilerUnsatV1(
            schemaVersion="1",
            status="UNSAT",
            reason=CompilerReasonV1(
                code="GOAL_NOT_CONFIRMED", message="Goal contract must be confirmed."
            ),
            relaxations=[],
        )
    if not isinstance(goal.goal, DeliverMoneyGoalV1):
        return CompilerUnsatV1(
            schemaVersion="1",
            status="UNSAT",
            reason=CompilerReasonV1(
                code="UNSUPPORTED_GOAL",
                message="The scaffold compiler supports only DELIVER_MONEY.",
            ),
            relaxations=[],
        )

    amount = int(goal.goal.amount.minor_units)
    currency = goal.goal.amount.currency
    account = next(
        (
            item
            for item in snapshot.accounts
            if item.currency == currency
            and item.status == "ACTIVE"
            and "SEND_TRANSFER" in item.capabilities
        ),
        None,
    )
    minimum = max(
        (
            int(item.money.minor_units)
            for item in goal.constraints
            if isinstance(item, MinAvailableBalanceV1) and item.money.currency == currency
        ),
        default=0,
    )
    binding = next(
        (
            item
            for item in goal.entity_bindings
            if item.reference == goal.goal.recipient_reference
            and item.entity_type == "BENEFICIARY"
            and item.confirmed
        ),
        None,
    )
    if account is None or binding is None or int(account.available_minor_units) - amount < minimum:
        return CompilerUnsatV1(
            schemaVersion="1",
            status="UNSAT",
            reason=CompilerReasonV1(
                code="MINIMUM_LIQUIDITY",
                message="Available funds or confirmed beneficiary cannot satisfy the goal.",
            ),
            relaxations=[],
        )

    seed = {
        "goal": goal.model_dump(mode="json", by_alias=True),
        "stateVersion": snapshot.state_version,
        "compiler": COMPILER_VERSION,
    }
    plan_hash = hashlib.sha256(
        json.dumps(seed, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    plan_id = str(uuid5(NAMESPACE_URL, plan_hash))
    step = TransferPlanStepV1(
        id=f"{plan_id}:0",
        sequence=0,
        action="TRANSFER",
        dependsOn=[],
        reversible=False,
        parameters={
            "sourceAccountId": account.id,
            "beneficiaryId": binding.entity_id,
            "amount": goal.goal.amount.model_dump(mode="json", by_alias=True),
        },
    )
    remaining = str(int(account.available_minor_units) - amount)
    plan = FinancialPlanV1(
        schemaVersion="1",
        id=plan_id,
        goalContractId=goal.id,
        goalContractVersion=goal.version,
        bankStateVersion=snapshot.state_version,
        compilerVersion=COMPILER_VERSION,
        policyVersion="scaffold-0.1",
        operationLibraryVersion="scaffold-0.1",
        steps=[step],
        validity=PlanValidityV1(requiredQuoteIds=[]),
        projectedOutcome=ProjectedOutcomeV1(
            goalSatisfied=True,
            deliveredMoney=goal.goal.amount,
            acquiredAssets=[],
            paidObligationIds=[],
            projectedAvailableBalances=[
                {
                    "accountId": account.id,
                    "money": MoneyV1(currency=currency, minorUnits=remaining).model_dump(
                        mode="json", by_alias=True
                    ),
                }
            ],
            warnings=[],
        ),
        planHash=plan_hash,
    )
    return CompilerSatV1(schemaVersion="1", status="SAT", plan=plan)
