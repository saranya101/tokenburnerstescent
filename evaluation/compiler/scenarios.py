"""Declared C7 cases and deterministic builders; expected results are independent data."""

from copy import deepcopy
from dataclasses import dataclass
from datetime import timedelta
from pathlib import Path
from typing import Any

from app.models.contracts import (
    AccountV1,
    BankStateSnapshotV1,
    GoalContractV1,
    GroundedGoalConstraintV1,
    GroundedPreferenceV1,
    HardRule,
    ObligationV1,
)
from app.planner.compiler import compile_goal
from app.policy.engine import PolicyEngine
from pydantic import TypeAdapter

FIXTURES = Path(__file__).resolve().parents[2] / "packages/contracts/fixtures"


@dataclass(frozen=True)
class Case:
    id: str
    family: str
    kind: str
    variant: str
    expected: str
    route: tuple[str, ...] = ()
    reason: str | None = None
    amount: str | None = None


def seed(folder: str = "01-ntu-transfer") -> tuple[GoalContractV1, BankStateSnapshotV1]:
    goal = GoalContractV1.model_validate_json(
        (FIXTURES / folder / "goal-contract.json").read_text()
    )
    state = BankStateSnapshotV1.model_validate_json(
        (FIXTURES / folder / "bank-state.json").read_text()
    )
    goal.constraints = []
    goal.preferences = []
    return goal, state


def add_account(state, name, currency, funds, capabilities, status="ACTIVE"):
    state.accounts.append(
        AccountV1.model_validate(
            {
                "id": name,
                "type": "WALLET",
                "currency": currency,
                "ledgerMinorUnits": str(funds),
                "availableMinorUnits": str(funds),
                "status": status,
                "capabilities": capabilities,
            }
        )
    )


def set_balance(account, amount):
    account.available_minor_units = str(amount)
    account.ledger_minor_units = str(amount)


def constraint(goal, kind, currency=None, amount=None, account_id=None):
    item: dict[str, Any] = {"type": kind}
    if currency is not None:
        item["money"] = {"currency": currency, "minorUnits": str(amount)}
    if account_id is not None:
        item["accountId"] = account_id
    goal.constraints.append(TypeAdapter(GroundedGoalConstraintV1).validate_python(item))


def preference(goal, kind, account_id=None):
    item = {"type": kind}
    if account_id:
        item["accountId"] = account_id
    goal.preferences.append(TypeAdapter(GroundedPreferenceV1).validate_python(item))


def hard(kind, currency=None, amount=None, account_id=None):
    item: dict[str, Any] = {
        "schemaVersion": "1",
        "id": f"c7-{kind.lower()}-{account_id or 'global'}",
        "userId": "user-1",
        "type": kind,
        "enabled": True,
    }
    if currency is not None:
        item["money"] = {"currency": currency, "minorUnits": str(amount)}
    if account_id is not None:
        item["accountId"] = account_id
    return TypeAdapter(HardRule).validate_python(item)


def obligation(state, name, amount, days, status="OPEN", currency="SGD"):
    state.obligations.append(
        ObligationV1.model_validate(
            {
                "id": name,
                "description": name,
                "money": {"currency": currency, "minorUnits": str(amount)},
                "dueAt": (state.captured_at + timedelta(days=days)).isoformat(),
                "status": status,
            }
        )
    )


def make(case: Case):
    """Return independently built case inputs; no mutable fixture is shared."""
    goal, state = seed(
        "05-balance-changed" if case.variant == "grounded_move" else "01-ntu-transfer"
    )
    rules = ()
    policy = PolicyEngine()
    variant = case.variant
    if variant in {
        "direct",
        "direct_irrelevant",
        "direct_drop",
        "direct_alternate",
        "direct_frozen",
        "direct_blocked",
        "direct_unverified",
        "direct_service",
        "direct_excluded",
        "direct_reserve_low",
        "direct_reserve_exact",
        "direct_reserve_too_high",
        "direct_max_tx",
        "direct_max_tx_exact",
        "direct_multi",
        "direct_ambiguous",
        "direct_preferred",
        "direct_many",
        "direct_insufficient",
    }:
        state.accounts.clear()
        add_account(state, "main-usd", "USD", 600000, ["SEND_TRANSFER"])
    if variant == "direct_irrelevant":
        add_account(state, "unused-sgd", "SGD", 100, ["SEND_TRANSFER"])
    elif variant == "direct_drop":
        set_balance(state.accounts[0], 100)
    elif variant == "direct_alternate":
        set_balance(state.accounts[0], 0)
        add_account(state, "alternate-usd", "USD", 600000, ["SEND_TRANSFER"])
    elif variant == "direct_frozen":
        state.accounts[0].status = "FROZEN"
    elif variant == "direct_blocked":
        state.beneficiaries[0].status = "BLOCKED"
    elif variant == "direct_unverified":
        state.beneficiaries[0].status = "PENDING_VERIFICATION"
    elif variant == "direct_service":
        state.service_availability.transfers = False
    elif variant == "direct_excluded":
        rules = (hard("EXCLUDED_ACCOUNT", account_id="main-usd"),)
    elif variant == "direct_reserve_low":
        constraint(goal, "MIN_AVAILABLE_BALANCE", "USD", 100001)
    elif variant == "direct_reserve_exact":
        constraint(goal, "MIN_AVAILABLE_BALANCE", "USD", 100000)
    elif variant == "direct_reserve_too_high":
        constraint(goal, "MIN_AVAILABLE_BALANCE", "USD", 100001)
    elif variant == "direct_max_tx":
        rules = (hard("MAX_SINGLE_TRANSACTION", "USD", 499999),)
    elif variant == "direct_max_tx_exact":
        rules = (hard("MAX_SINGLE_TRANSACTION", "USD", 500000),)
    elif variant == "direct_multi":
        constraint(goal, "MIN_AVAILABLE_BALANCE", "USD", 100000)
        rules = (hard("MAX_SINGLE_TRANSACTION", "USD", 500000),)
    elif variant == "direct_ambiguous":
        add_account(state, "second-usd", "USD", 600000, ["SEND_TRANSFER"])
    elif variant == "direct_preferred":
        add_account(state, "preferred-usd", "USD", 600000, ["SEND_TRANSFER"])
        preference(goal, "PREFER_ACCOUNT", "preferred-usd")
    elif variant == "direct_insufficient":
        set_balance(state.accounts[0], 499999)
    elif variant == "grounded_move":
        goal.goal.amount.minor_units = "10000"
    elif variant in {"move_transfer", "move_fx_transfer", "move_loop"}:
        if variant == "move_transfer":
            goal.goal.amount.currency = "SGD"
            goal.goal.amount.minor_units = "500000"
            state.accounts.clear()
            add_account(state, "source", "SGD", 300000, ["SEND_TRANSFER"])
            add_account(
                state,
                "destination",
                "SGD",
                250000,
                ["SEND_TRANSFER", "RECEIVE_TRANSFER"],
            )
        elif variant == "move_fx_transfer":
            set_balance(state.accounts[0], 0)
            state.accounts[0].capabilities.append("RECEIVE_TRANSFER")
            add_account(state, "funding", "SGD", 800000, ["SEND_TRANSFER"])
        else:
            goal.goal.amount.currency = "SGD"
            goal.goal.amount.minor_units = "800000"
            state.accounts.clear()
            for index in range(4):
                add_account(
                    state,
                    f"loop-{index}",
                    "SGD",
                    200000,
                    ["SEND_TRANSFER", "RECEIVE_TRANSFER"],
                )
    elif variant == "fx_unavailable":
        state.service_availability.fx = False
    elif variant == "fx_expired":
        state.fx_quotes[0].expires_at = state.captured_at
    elif variant == "fx_missing":
        state.fx_quotes.clear()
    elif variant == "fx_no_destination":
        state.accounts[1].capabilities.remove("RECEIVE_TRANSFER")
    elif variant == "fx_quote_changed":
        state.fx_quotes[0].rate = "0.750000001"
    elif variant == "fx_prefer_no_fx":
        add_account(state, "direct-usd", "USD", 600000, ["SEND_TRANSFER"])
        preference(goal, "MINIMIZE_FX")
    elif variant == "fx_min_cost":
        other = deepcopy(state.fx_quotes[0])
        other.id = "expensive-quote"
        other.fee.minor_units = "1000"
        state.fx_quotes.append(other)
        preference(goal, "MINIMIZE_TOTAL_COST")
        constraint(goal, "MAX_TOTAL_COST", "SGD", 700000)
    elif variant == "fx_equivalent":
        other = deepcopy(state.fx_quotes[0])
        other.id = "equivalent-quote"
        state.fx_quotes.append(other)
    elif variant == "fx_max_cost_low":
        constraint(goal, "MAX_TOTAL_COST", "SGD", 666765)
    elif variant == "fx_max_cost_exact":
        constraint(goal, "MAX_TOTAL_COST", "SGD", 666766)
    elif variant == "fx_reserve":
        constraint(goal, "MIN_AVAILABLE_BALANCE", "SGD", 400000)
    elif variant == "fx_excluded":
        rules = (hard("EXCLUDED_ACCOUNT", account_id="acc-sgd"),)
    elif variant == "fx_multi":
        constraint(goal, "MAX_TOTAL_COST", "SGD", 666766)
        constraint(goal, "MIN_AVAILABLE_BALANCE", "SGD", 30000)
    elif variant == "fx_bad_rate":
        state.fx_quotes[0].rate = "not-a-rate"
    elif variant == "fx_mixed_cost":
        constraint(goal, "MAX_TOTAL_COST", "EUR", 1000000)
    if case.kind in {"preflight", "preservation", "revalidation", "replanning"}:
        goal, original = seed()
        if variant.startswith("direct_") and variant not in {"direct_preferred"}:
            original.accounts.clear()
            add_account(original, "original-usd", "USD", 600000, ["SEND_TRANSFER"])
        initial = compile_goal(goal, original)
        if initial.status != "SAT":
            raise AssertionError(
                f"initial plan unavailable: {case.id}: {initial.status}"
            )
        state = deepcopy(original)
        plan = initial.plan
        if variant in {
            "direct_irrelevant",
            "direct_drop",
            "direct_alternate",
            "direct_blocked",
            "direct_service",
            "direct_frozen",
            "direct_reserve_too_high",
        }:
            state.state_version += 1
            if variant == "direct_irrelevant":
                add_account(state, "unused-sgd", "SGD", 20, ["SEND_TRANSFER"])
            elif variant == "direct_drop":
                set_balance(state.accounts[0], 0)
            elif variant == "direct_alternate":
                set_balance(state.accounts[0], 0)
                add_account(state, "alternate-usd", "USD", 600000, ["SEND_TRANSFER"])
            elif variant == "direct_blocked":
                state.beneficiaries[0].status = "BLOCKED"
            elif variant == "direct_service":
                state.service_availability.transfers = False
            elif variant == "direct_frozen":
                state.accounts[0].status = "FROZEN"
            elif variant == "direct_reserve_too_high":
                rules = (hard("MIN_AVAILABLE_BALANCE", "USD", 200000),)
        elif variant in {
            "outage",
            "beneficiary_blocked",
            "destination_lost",
            "fx_off",
            "source_frozen",
            "source_drop",
            "quote_expired",
            "quote_replaced",
            "quote_changed",
            "quote_missing",
            "reserve_binding",
            "excluded_binding",
        }:
            state.state_version += 1
            if variant == "outage":
                state.service_availability.transfers = False
            elif variant == "beneficiary_blocked":
                state.beneficiaries[0].status = "BLOCKED"
            elif variant == "destination_lost":
                state.accounts[1].capabilities.remove("SEND_TRANSFER")
            elif variant == "fx_off":
                state.service_availability.fx = False
            elif variant == "source_frozen":
                state.accounts[0].status = "FROZEN"
            elif variant == "source_drop":
                set_balance(state.accounts[0], 0)
            elif variant in {"quote_expired", "quote_replaced"}:
                state.captured_at = state.fx_quotes[0].expires_at
                if variant == "quote_replaced":
                    new = deepcopy(state.fx_quotes[0])
                    new.id = "replacement-quote"
                    new.expires_at += timedelta(minutes=5)
                    state.fx_quotes.append(new)
            elif variant == "quote_changed":
                state.fx_quotes[0].rate = "0.750000001"
            elif variant == "quote_missing":
                state.fx_quotes.clear()
            elif variant == "reserve_binding":
                rules = (hard("MIN_AVAILABLE_BALANCE", "SGD", 500000),)
            elif variant == "excluded_binding":
                rules = (hard("EXCLUDED_ACCOUNT", account_id="acc-sgd"),)
        return goal, state, rules, policy, plan
    return goal, state, rules, policy, None


CASES = (
    # Planning: independently declared expected outcomes and route checks.
    Case("direct_transfer", "basic", "planning", "direct", "SAT", ("TRANSFER",)),
    Case("fx_transfer", "basic", "planning", "fx", "SAT", ("FX_CONVERT", "TRANSFER")),
    Case(
        "move_transfer",
        "basic",
        "planning",
        "move_transfer",
        "SAT",
        ("MOVE_FUNDS", "TRANSFER"),
    ),
    Case(
        "move_fx_transfer",
        "basic",
        "planning",
        "move_fx_transfer",
        "SAT",
        ("MOVE_FUNDS", "FX_CONVERT", "TRANSFER"),
    ),
    Case("grounded_move", "basic", "planning", "grounded_move", "SAT", ("MOVE_FUNDS",)),
    Case("excluded_account", "constraints", "planning", "direct_excluded", "UNSAT"),
    Case(
        "minimum_reserve",
        "constraints",
        "planning",
        "direct_reserve_low",
        "UNSAT",
        reason="MIN_AVAILABLE_BALANCE_VIOLATED",
    ),
    Case(
        "exact_reserve_boundary",
        "constraints",
        "planning",
        "direct_reserve_exact",
        "SAT",
        ("TRANSFER",),
    ),
    Case(
        "max_cost_too_low",
        "constraints",
        "planning",
        "fx_max_cost_low",
        "UNSAT",
        reason="MAX_TOTAL_COST_TOO_LOW",
    ),
    Case(
        "exact_max_cost",
        "constraints",
        "planning",
        "fx_max_cost_exact",
        "SAT",
        ("FX_CONVERT", "TRANSFER"),
    ),
    Case(
        "simultaneous_constraints",
        "constraints",
        "planning",
        "direct_multi",
        "SAT",
        ("TRANSFER",),
    ),
    Case(
        "max_single_transaction_low",
        "constraints",
        "planning",
        "direct_max_tx",
        "UNSAT",
    ),
    Case(
        "max_single_transaction_exact",
        "constraints",
        "planning",
        "direct_max_tx_exact",
        "SAT",
        ("TRANSFER",),
    ),
    Case("frozen_source", "policy", "planning", "direct_frozen", "POLICY_BLOCKED"),
    Case(
        "blocked_beneficiary",
        "policy",
        "planning",
        "direct_blocked",
        "POLICY_BLOCKED",
        reason="BENEFICIARY_BLOCKED",
    ),
    Case(
        "unverified_beneficiary",
        "policy",
        "planning",
        "direct_unverified",
        "POLICY_BLOCKED",
        reason="BENEFICIARY_UNVERIFIED",
    ),
    Case(
        "transfer_unavailable", "policy", "planning", "direct_service", "POLICY_BLOCKED"
    ),
    Case("fx_unavailable", "policy", "planning", "fx_unavailable", "POLICY_BLOCKED"),
    Case("valid_quote", "fx", "planning", "fx", "SAT", ("FX_CONVERT", "TRANSFER")),
    Case(
        "expired_quote", "fx", "planning", "fx_expired", "UNSAT", reason="QUOTE_EXPIRED"
    ),
    Case(
        "missing_quote", "fx", "planning", "fx_missing", "UNSAT", reason="NO_FX_ROUTE"
    ),
    Case(
        "quote_rate_changed",
        "fx",
        "planning",
        "fx_quote_changed",
        "SAT",
        ("FX_CONVERT", "TRANSFER"),
    ),
    Case("no_fx_destination", "fx", "planning", "fx_no_destination", "UNSAT"),
    Case(
        "equivalent_routes",
        "search",
        "planning",
        "fx_equivalent",
        "SAT",
        ("FX_CONVERT", "TRANSFER"),
    ),
    Case(
        "material_ambiguity",
        "search",
        "planning",
        "direct_ambiguous",
        "UNSAT",
        reason="AMBIGUOUS_VALID_PLANS",
    ),
    Case("minimize_fx", "search", "planning", "fx_prefer_no_fx", "SAT", ("TRANSFER",)),
    Case(
        "minimize_cost",
        "search",
        "planning",
        "fx_min_cost",
        "SAT",
        ("FX_CONVERT", "TRANSFER"),
    ),
    Case(
        "prefer_account", "search", "planning", "direct_preferred", "SAT", ("TRANSFER",)
    ),
    Case(
        "loop_graph",
        "search",
        "planning",
        "move_loop",
        "UNSAT",
        reason="MAX_STATES_EXPLORED",
    ),
    Case(
        "depth_bound",
        "search",
        "planning",
        "fx",
        "UNSAT",
        reason="SEARCH_DEPTH_EXHAUSTED",
    ),
    Case(
        "state_bound", "search", "planning", "fx", "UNSAT", reason="MAX_STATES_EXPLORED"
    ),
    Case(
        "insufficient_funds", "constraints", "planning", "direct_insufficient", "UNSAT"
    ),
    Case("fx_reserve_violation", "constraints", "planning", "fx_reserve", "UNSAT"),
    Case("fx_excluded", "constraints", "planning", "fx_excluded", "UNSAT"),
    Case(
        "fx_multiple_constraints",
        "constraints",
        "planning",
        "fx_multi",
        "SAT",
        ("FX_CONVERT", "TRANSFER"),
    ),
    Case("mixed_cost_attribution", "constraints", "planning", "fx_mixed_cost", "UNSAT"),
    Case("whole_plan_preflight", "preflight", "preflight", "fx", "READY"),
    Case(
        "tampered_plan_preflight",
        "preflight",
        "preflight",
        "preflight_tampered",
        "INVALID_PLAN",
    ),
    Case(
        "expired_quote_preflight",
        "preflight",
        "preflight",
        "preflight_expired",
        "INVALID_PLAN",
    ),
    Case(
        "irrelevant_version",
        "revalidation",
        "revalidation",
        "direct_irrelevant",
        "PLAN_STILL_VALID",
    ),
    Case(
        "balance_drop", "revalidation", "revalidation", "direct_drop", "GOAL_NOW_UNSAT"
    ),
    Case(
        "alternate_balance",
        "revalidation",
        "revalidation",
        "direct_alternate",
        "REPLAN_REQUIRED",
    ),
    Case(
        "quote_expiry",
        "revalidation",
        "revalidation",
        "quote_expired",
        "GOAL_NOW_UNSAT",
    ),
    Case(
        "quote_replacement",
        "revalidation",
        "revalidation",
        "quote_replaced",
        "REPLAN_REQUIRED",
    ),
    Case("service_outage", "revalidation", "revalidation", "outage", "POLICY_BLOCKED"),
    Case(
        "beneficiary_blocked_later",
        "revalidation",
        "revalidation",
        "beneficiary_blocked",
        "POLICY_BLOCKED",
    ),
    Case(
        "goal_preservation_transfer_outage",
        "preservation",
        "preservation",
        "outage",
        "WOULD_BREAK_GOAL",
    ),
    Case("preserve_valid_fx", "preservation", "preservation", "fx", "PRESERVED"),
    Case(
        "preserve_beneficiary_blocked",
        "preservation",
        "preservation",
        "beneficiary_blocked",
        "WOULD_BREAK_GOAL",
    ),
    Case(
        "preserve_destination_lost",
        "preservation",
        "preservation",
        "destination_lost",
        "WOULD_BREAK_GOAL",
    ),
    Case(
        "replan_alternate_source",
        "replanning",
        "replanning",
        "direct_alternate",
        "REPLANNED",
    ),
    Case("replan_new_quote", "replanning", "replanning", "quote_replaced", "REPLANNED"),
    Case(
        "replan_no_alternative", "replanning", "replanning", "direct_drop", "GOAL_UNSAT"
    ),
    Case(
        "relax_cost_one_unit",
        "relaxation",
        "relaxation",
        "fx_max_cost_low",
        "RELAXATION_FOUND",
        amount="666766",
    ),
    Case(
        "relax_reserve_one_unit",
        "relaxation",
        "relaxation",
        "reserve_one_unit",
        "RELAXATION_FOUND",
        amount="300000",
    ),
    Case(
        "max_feasible_transfer",
        "relaxation",
        "maximum",
        "max_transfer",
        "FEASIBLE",
        amount="165000",
    ),
    Case(
        "above_reserve",
        "opportunity",
        "opportunity",
        "above_reserve",
        "FACT",
        amount="320000",
    ),
    Case(
        "after_obligations",
        "opportunity",
        "opportunity",
        "after_obligations",
        "FACT",
        amount="165000",
    ),
    Case(
        "reserve_gap",
        "opportunity",
        "opportunity",
        "reserve_gap",
        "RESERVE_SHORTFALL",
        amount="60000",
    ),
    Case(
        "obligation_shortfall",
        "opportunity",
        "opportunity",
        "obligation_shortfall",
        "PARTIALLY_COVERED",
        amount="100000",
    ),
    Case(
        "exact_max_opportunity",
        "opportunity",
        "opportunity",
        "max_opportunity",
        "FEASIBLE",
        amount="165000",
    ),
)
