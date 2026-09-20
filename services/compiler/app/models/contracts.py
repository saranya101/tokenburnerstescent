from __future__ import annotations

from datetime import datetime
from typing import Annotated, Any, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, model_validator


def to_camel(value: str) -> str:
    parts = value.split("_")
    return parts[0] + "".join(part.title() for part in parts[1:])


class ContractModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")


class MoneyV1(ContractModel):
    currency: str = Field(pattern=r"^[A-Z]{3}$")
    minor_units: str = Field(pattern=r"^-?(0|[1-9]\d*)$")


class DeliverMoneyIntentGoalV1(ContractModel):
    type: Literal["DELIVER_MONEY"]
    amount: MoneyV1
    recipient_reference: str


class AcquireAssetIntentGoalV1(ContractModel):
    type: Literal["ACQUIRE_ASSET"]
    asset_reference: str
    budget: MoneyV1 | None = None
    quantity: str | None = Field(default=None, pattern=r"^(0|[1-9]\d*)(\.\d+)?$")

    @model_validator(mode="after")
    def require_budget_or_quantity(self) -> Self:
        if self.budget is None and self.quantity is None:
            raise ValueError("ACQUIRE_ASSET requires budget, quantity, or both")
        return self


class PayBillIntentGoalV1(ContractModel):
    type: Literal["PAY_BILL"]
    biller_reference: str
    amount: MoneyV1 | None = None


class MoveFundsIntentGoalV1(ContractModel):
    type: Literal["MOVE_FUNDS"]
    amount: MoneyV1
    source_account_reference: str | None = None
    destination_account_reference: str


IntentGoalV1 = Annotated[
    DeliverMoneyIntentGoalV1
    | AcquireAssetIntentGoalV1
    | PayBillIntentGoalV1
    | MoveFundsIntentGoalV1,
    Field(discriminator="type"),
]


class MaxTotalCostIntentV1(ContractModel):
    type: Literal["MAX_TOTAL_COST"]
    money: MoneyV1


class MinAvailableBalanceIntentV1(ContractModel):
    type: Literal["MIN_AVAILABLE_BALANCE"]
    money: MoneyV1
    account_reference: str | None = None


class ExcludedAccountIntentV1(ContractModel):
    type: Literal["EXCLUDED_ACCOUNT"]
    account_reference: str


class MaxLockInDaysIntentV1(ContractModel):
    type: Literal["MAX_LOCK_IN_DAYS"]
    days: int = Field(ge=0)


IntentGoalConstraintV1 = Annotated[
    MaxTotalCostIntentV1
    | MinAvailableBalanceIntentV1
    | ExcludedAccountIntentV1
    | MaxLockInDaysIntentV1,
    Field(discriminator="type"),
]


class MinimizeTotalCostIntentPreferenceV1(ContractModel):
    type: Literal["MINIMIZE_TOTAL_COST"]


class MinimizeFxIntentPreferenceV1(ContractModel):
    type: Literal["MINIMIZE_FX"]


class FastestIntentPreferenceV1(ContractModel):
    type: Literal["FASTEST"]


class PreferAccountIntentPreferenceV1(ContractModel):
    type: Literal["PREFER_ACCOUNT"]
    account_reference: str


IntentPreferenceV1 = Annotated[
    MinimizeTotalCostIntentPreferenceV1
    | MinimizeFxIntentPreferenceV1
    | FastestIntentPreferenceV1
    | PreferAccountIntentPreferenceV1,
    Field(discriminator="type"),
]


class IntentReferenceV1(ContractModel):
    reference: str
    expected_entity_type: (
        Literal["ACCOUNT", "BENEFICIARY", "ASSET", "BILLER", "OBLIGATION"] | None
    ) = None


class IntentDraftV1(ContractModel):
    schema_version: Literal["1"]
    original_text: str
    goal: IntentGoalV1
    constraints: list[IntentGoalConstraintV1]
    preferences: list[IntentPreferenceV1]
    references: list[IntentReferenceV1]


class EntityBinding(ContractModel):
    schema_version: Literal["1"]
    reference: str
    entity_type: Literal["ACCOUNT", "BENEFICIARY", "ASSET", "BILLER", "OBLIGATION"]
    entity_id: str
    resolution_method: Literal["EXACT", "ALIAS", "SEMANTIC", "USER_CONFIRMED"]
    confidence: str | None = Field(default=None, pattern=r"^(0|[1-9]\d*)(\.\d+)?$")
    confirmed: bool


class MinAvailableBalanceHardRuleV1(ContractModel):
    schema_version: Literal["1"]
    id: str
    user_id: str
    type: Literal["MIN_AVAILABLE_BALANCE"]
    enabled: bool
    money: MoneyV1
    account_id: str | None = None


class ExcludedAccountHardRuleV1(ContractModel):
    schema_version: Literal["1"]
    id: str
    user_id: str
    type: Literal["EXCLUDED_ACCOUNT"]
    enabled: bool
    account_id: str


class MaxSingleTransactionHardRuleV1(ContractModel):
    schema_version: Literal["1"]
    id: str
    user_id: str
    type: Literal["MAX_SINGLE_TRANSACTION"]
    enabled: bool
    money: MoneyV1


HardRule = Annotated[
    MinAvailableBalanceHardRuleV1 | ExcludedAccountHardRuleV1 | MaxSingleTransactionHardRuleV1,
    Field(discriminator="type"),
]


class DeliverMoneyGroundedGoalV1(ContractModel):
    type: Literal["DELIVER_MONEY"]
    amount: MoneyV1
    recipient_id: str


class AcquireAssetGroundedGoalV1(ContractModel):
    type: Literal["ACQUIRE_ASSET"]
    asset_id: str
    budget: MoneyV1 | None = None
    quantity: str | None = Field(default=None, pattern=r"^(0|[1-9]\d*)(\.\d+)?$")

    @model_validator(mode="after")
    def require_budget_or_quantity(self) -> Self:
        if self.budget is None and self.quantity is None:
            raise ValueError("ACQUIRE_ASSET requires budget, quantity, or both")
        return self


class PayBillGroundedGoalV1(ContractModel):
    type: Literal["PAY_BILL"]
    biller_id: str
    amount: MoneyV1 | None = None


class MoveFundsGroundedGoalV1(ContractModel):
    type: Literal["MOVE_FUNDS"]
    amount: MoneyV1
    source_account_id: str | None = None
    destination_account_id: str


GroundedGoalV1 = Annotated[
    DeliverMoneyGroundedGoalV1
    | AcquireAssetGroundedGoalV1
    | PayBillGroundedGoalV1
    | MoveFundsGroundedGoalV1,
    Field(discriminator="type"),
]


class MaxTotalCostGroundedV1(ContractModel):
    type: Literal["MAX_TOTAL_COST"]
    money: MoneyV1


class MinAvailableBalanceGroundedV1(ContractModel):
    type: Literal["MIN_AVAILABLE_BALANCE"]
    money: MoneyV1
    account_id: str | None = None


class ExcludedAccountGroundedV1(ContractModel):
    type: Literal["EXCLUDED_ACCOUNT"]
    account_id: str


class MaxLockInDaysGroundedV1(ContractModel):
    type: Literal["MAX_LOCK_IN_DAYS"]
    days: int = Field(ge=0)


GroundedGoalConstraintV1 = Annotated[
    MaxTotalCostGroundedV1
    | MinAvailableBalanceGroundedV1
    | ExcludedAccountGroundedV1
    | MaxLockInDaysGroundedV1,
    Field(discriminator="type"),
]


class MinimizeTotalCostGroundedPreferenceV1(ContractModel):
    type: Literal["MINIMIZE_TOTAL_COST"]


class MinimizeFxGroundedPreferenceV1(ContractModel):
    type: Literal["MINIMIZE_FX"]


class FastestGroundedPreferenceV1(ContractModel):
    type: Literal["FASTEST"]


class PreferAccountGroundedPreferenceV1(ContractModel):
    type: Literal["PREFER_ACCOUNT"]
    account_id: str


GroundedPreferenceV1 = Annotated[
    MinimizeTotalCostGroundedPreferenceV1
    | MinimizeFxGroundedPreferenceV1
    | FastestGroundedPreferenceV1
    | PreferAccountGroundedPreferenceV1,
    Field(discriminator="type"),
]


class GoalContractV1(ContractModel):
    schema_version: Literal["1"]
    id: str
    user_id: str
    version: int = Field(gt=0)
    source_intent_draft_id: str | None = None
    goal: GroundedGoalV1
    constraints: list[GroundedGoalConstraintV1]
    preferences: list[GroundedPreferenceV1]
    entity_bindings: list[EntityBinding]
    status: Literal[
        "DRAFT",
        "AWAITING_CLARIFICATION",
        "AWAITING_GOAL_CONFIRMATION",
        "CONFIRMED",
        "PLANNING",
        "AWAITING_APPROVAL",
        "AUTHORIZED",
        "EXECUTING",
        "PAUSED",
        "REAPPROVAL_REQUIRED",
        "COMPLETED",
        "FAILED",
        "CANCELLED",
    ]
    contract_hash: str
    created_at: datetime
    confirmed_at: datetime | None = None


class AccountV1(ContractModel):
    id: str
    type: Literal["CHECKING", "SAVINGS", "BROKERAGE", "WALLET"]
    currency: str
    ledger_minor_units: str
    available_minor_units: str
    status: Literal["ACTIVE", "FROZEN", "CLOSED"]
    capabilities: list[
        Literal["SEND_TRANSFER", "RECEIVE_TRANSFER", "CONVERT_FX", "PAY_BILL", "TRADE_ASSET"]
    ]


class BeneficiaryV1(ContractModel):
    id: str
    name: str
    supported_currencies: list[str]
    status: Literal["ACTIVE", "BLOCKED", "PENDING_VERIFICATION"]


class AssetV1(ContractModel):
    id: str
    symbol: str
    name: str
    asset_type: Literal["EQUITY", "ETF", "BOND", "FUND", "CRYPTO", "OTHER"]
    tradable: bool
    settlement_currency: str


class HoldingV1(ContractModel):
    asset_id: str
    quantity: str


class ObligationV1(ContractModel):
    id: str
    description: str
    money: MoneyV1
    due_at: datetime
    status: Literal["OPEN", "PAID", "OVERDUE", "CANCELLED"]


class ServiceAvailabilityV1(ContractModel):
    transfers: bool
    fx: bool
    bill_payments: bool
    investments: bool


class FxQuoteV1(ContractModel):
    id: str
    from_currency: str
    to_currency: str
    rate: str
    fee: MoneyV1 | None = None
    expires_at: datetime


class BankStateSnapshotV1(ContractModel):
    schema_version: Literal["1"]
    user_id: str
    state_version: int = Field(ge=0)
    captured_at: datetime
    accounts: list[AccountV1]
    beneficiaries: list[BeneficiaryV1]
    assets: list[AssetV1]
    holdings: list[HoldingV1]
    obligations: list[ObligationV1]
    service_availability: ServiceAvailabilityV1
    fx_quotes: list[FxQuoteV1]


class StepBaseV1(ContractModel):
    id: str
    sequence: int = Field(ge=0)
    depends_on: list[str]
    reversible: bool


class TransferParametersV1(ContractModel):
    source_account_id: str
    beneficiary_id: str
    amount: MoneyV1


class FxConvertParametersV1(ContractModel):
    account_id: str
    from_amount: MoneyV1
    to_currency: str
    quote_id: str


class MoveFundsParametersV1(ContractModel):
    source_account_id: str
    destination_account_id: str
    amount: MoneyV1


class PayBillParametersV1(ContractModel):
    source_account_id: str
    obligation_id: str
    amount: MoneyV1


class BuyAssetParametersV1(ContractModel):
    source_account_id: str
    asset_id: str
    quantity: str
    maximum_spend: MoneyV1


class SellAssetParametersV1(ContractModel):
    destination_account_id: str
    asset_id: str
    quantity: str


class TransferPlanStepV1(StepBaseV1):
    action: Literal["TRANSFER"]
    parameters: TransferParametersV1


class FxConvertPlanStepV1(StepBaseV1):
    action: Literal["FX_CONVERT"]
    parameters: FxConvertParametersV1


class MoveFundsPlanStepV1(StepBaseV1):
    action: Literal["MOVE_FUNDS"]
    parameters: MoveFundsParametersV1


class PayBillPlanStepV1(StepBaseV1):
    action: Literal["PAY_BILL"]
    parameters: PayBillParametersV1


class BuyAssetPlanStepV1(StepBaseV1):
    action: Literal["BUY_ASSET"]
    parameters: BuyAssetParametersV1


class SellAssetPlanStepV1(StepBaseV1):
    action: Literal["SELL_ASSET"]
    parameters: SellAssetParametersV1


FinancialPlanStepV1 = Annotated[
    TransferPlanStepV1
    | FxConvertPlanStepV1
    | MoveFundsPlanStepV1
    | PayBillPlanStepV1
    | BuyAssetPlanStepV1
    | SellAssetPlanStepV1,
    Field(discriminator="action"),
]


class OperationDefinitionV1(ContractModel):
    name: Literal["TRANSFER", "FX_CONVERT", "MOVE_FUNDS", "PAY_BILL", "BUY_ASSET", "SELL_ASSET"]
    parameters: list[str]
    preconditions: list[str]
    effects: list[str]
    cost_model: str
    availability: str
    reversible: bool


class AssetQuantityV1(ContractModel):
    asset_id: str
    quantity: str


class ProjectedBalanceV1(ContractModel):
    account_id: str
    money: MoneyV1


class ProjectedOutcomeV1(ContractModel):
    goal_satisfied: bool
    delivered_money: MoneyV1 | None = None
    acquired_assets: list[AssetQuantityV1]
    paid_obligation_ids: list[str]
    projected_available_balances: list[ProjectedBalanceV1]
    warnings: list[str]


class PlanValidityV1(ContractModel):
    valid_until: datetime | None = None
    required_quote_ids: list[str]


class FinancialPlanV1(ContractModel):
    schema_version: Literal["1"]
    id: str
    goal_contract_id: str
    goal_contract_version: int = Field(gt=0)
    bank_state_version: int = Field(ge=0)
    compiler_version: str
    policy_version: str
    operation_library_version: str
    steps: list[FinancialPlanStepV1]
    validity: PlanValidityV1
    projected_outcome: ProjectedOutcomeV1
    plan_hash: str


class CompilerReasonV1(ContractModel):
    code: str
    message: str
    details: dict[str, Any] | None = None


class CompilerRelaxationV1(ContractModel):
    constraint_type: str
    suggestion: str


class CompilerSatV1(ContractModel):
    schema_version: Literal["1"]
    status: Literal["SAT"]
    plan: FinancialPlanV1


class CompilerUnsatV1(ContractModel):
    schema_version: Literal["1"]
    status: Literal["UNSAT"]
    reason: CompilerReasonV1
    relaxations: list[CompilerRelaxationV1]


class CompilerPolicyBlockedV1(ContractModel):
    schema_version: Literal["1"]
    status: Literal["POLICY_BLOCKED"]
    reason: CompilerReasonV1


CompilerResultV1 = Annotated[
    CompilerSatV1 | CompilerUnsatV1 | CompilerPolicyBlockedV1,
    Field(discriminator="status"),
]


class ApprovalV1(ContractModel):
    schema_version: Literal["1"]
    id: str
    user_id: str
    goal_contract_id: str
    goal_contract_version: int
    goal_contract_hash: str
    financial_plan_id: str
    financial_plan_hash: str
    bank_state_version: int
    method: Literal["BIOMETRIC", "PASSKEY", "PIN", "EXTERNAL_SIGNATURE"]
    approved_at: datetime
    expires_at: datetime
    signature_reference: str


class ExecutionStepResultV1(ContractModel):
    step_id: str
    status: Literal["PENDING", "ACCEPTED", "SETTLED", "FAILED", "UNKNOWN"]
    idempotency_key: str
    bank_reference: str | None = None
    error_code: str | None = None


class GoalOutcomeV1(ContractModel):
    achieved: bool
    summary: str
    delivered_money: MoneyV1 | None = None
    acquired_asset: AssetQuantityV1 | None = None


class ExecutionResultV1(ContractModel):
    schema_version: Literal["1"]
    execution_id: str
    plan_id: str
    status: Literal["PENDING", "EXECUTING", "COMPLETED", "FAILED", "UNKNOWN"]
    started_state_version: int
    final_state_version: int | None = None
    steps: list[ExecutionStepResultV1]
    goal_outcome: GoalOutcomeV1


class CompileRequest(ContractModel):
    goal_contract: GoalContractV1
    bank_state_snapshot: BankStateSnapshotV1


class RevalidateRequest(ContractModel):
    goal_contract: GoalContractV1
    financial_plan: FinancialPlanV1
    bank_state_snapshot: BankStateSnapshotV1


class OpportunitiesRequest(ContractModel):
    bank_state_snapshot: BankStateSnapshotV1
    hard_rules: list[dict[str, Any]] = Field(default_factory=list)
    goal_templates: list[dict[str, Any]] = Field(default_factory=list)
