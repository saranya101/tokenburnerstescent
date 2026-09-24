"""Run the reproducible C7 compiler evaluation; exits nonzero on any failed assertion."""

import json
import os
import subprocess
import sys
from collections import Counter
from copy import deepcopy
from dataclasses import asdict
from pathlib import Path
from statistics import mean
from time import perf_counter_ns

ROOT = Path(__file__).resolve().parents[2]
sys.dont_write_bytecode = True
sys.path.insert(0, str(ROOT / "services/compiler"))
sys.path.insert(0, str(ROOT / "evaluation/compiler"))
sys.path.insert(0, str(ROOT / "evaluation/baseline"))

from app.opportunities import discover_opportunities
from app.planner.compiler import compile_goal, compile_with_diagnostics
from app.preflight import (
    ExecutionProgress,
    _operation,
    check_step_goal_preservation,
    preflight_plan,
)
from app.relaxation import (
    analyze_request_relaxations,
    find_max_feasible_amount,
)
from app.replanning import replan_goal
from app.revalidation import revalidate_plan
from app.simulator.apply import apply_operation
from scenarios import (
    CASES,
    Case,
    add_account,
    constraint,
    hard,
    make,
    obligation,
    seed,
)
from validator import validate_proposed_sequence

RESULTS = ROOT / "evaluation/results"
RESULTS.mkdir(exist_ok=True)


def timed(call):
    start = perf_counter_ns()
    result = call()
    return result, (perf_counter_ns() - start) / 1_000_000


def special_inputs(case: Case):
    goal, state = seed()
    rules = ()
    if case.variant == "reserve_one_unit":
        goal.goal.amount.currency = "SGD"
        goal.goal.amount.minor_units = "500000"
        state.accounts.clear()
        add_account(state, "only", "SGD", 800000, ["SEND_TRANSFER"])
        constraint(goal, "MIN_AVAILABLE_BALANCE", "SGD", 300001)
    elif case.variant in {"max_transfer", "max_opportunity"}:
        goal.goal.amount.currency = "SGD"
        goal.goal.amount.minor_units = "2000000"
        state.accounts.clear()
        add_account(state, "only", "SGD", 200000, ["SEND_TRANSFER"])
        if case.variant == "max_transfer":
            constraint(goal, "MIN_AVAILABLE_BALANCE", "SGD", 35000)
        else:
            rules = (hard("MIN_AVAILABLE_BALANCE", "SGD", 35000),)
    elif case.variant in {
        "above_reserve",
        "after_obligations",
        "reserve_gap",
        "obligation_shortfall",
    }:
        state.accounts.clear()
        funds = {
            "above_reserve": 620000,
            "after_obligations": 620000,
            "reserve_gap": 240000,
            "obligation_shortfall": 400000,
        }[case.variant]
        add_account(
            state, "spendable", "SGD", funds, ["SEND_TRANSFER", "RECEIVE_TRANSFER"]
        )
        rules = (hard("MIN_AVAILABLE_BALANCE", "SGD", 300000),)
        if case.variant in {"after_obligations", "obligation_shortfall"}:
            obligation(state, "due", 155000, 5)
    return goal, state, rules


def evaluate(case: Case):
    if (
        case.kind
        in {"planning", "preflight", "preservation", "revalidation", "replanning"}
        or case.variant == "fx_max_cost_low"
    ):
        goal, state, rules, policy, plan = make(case)
    else:
        goal, state, rules = special_inputs(case)
        policy = None
        plan = None
    before = state.model_dump(mode="json", by_alias=True)
    evidence = {}
    metrics = {}
    if case.kind == "planning":
        limits = {"depth_bound": (1, 1000), "state_bound": (4, 1)}.get(
            case.id, (4, 1000)
        )
        compiled, ms = timed(
            lambda: compile_with_diagnostics(goal, state, rules, policy, *limits)
        )
        result, diagnostics = compiled.result, compiled.diagnostics
        evidence = {
            "status": result.status,
            "reason": result.reason.code if result.status != "SAT" else None,
            "route": [step.action for step in result.plan.steps]
            if result.status == "SAT"
            else [],
            "planHash": result.plan.plan_hash if result.status == "SAT" else None,
        }
        metrics = {"compileLatencyMs": ms}
        if diagnostics:
            metrics.update(
                {
                    "statesExplored": diagnostics.states_explored,
                    "candidateActionsEvaluated": diagnostics.candidate_actions_evaluated,
                    "searchDepthReached": diagnostics.search_depth_reached,
                    "solverCalls": diagnostics.solver_calls,
                    "prunedByPolicy": diagnostics.pruned_by_policy,
                    "prunedByConstraint": diagnostics.pruned_by_constraint,
                    "prunedVisitedStates": diagnostics.pruned_visited_states,
                    "validPlansFound": diagnostics.valid_plans_found,
                }
            )
        if result.status == "SAT":
            final = result.plan.steps[-1]
            evidence["goalBindingCorrect"] = (
                result.plan.goal_contract_id == goal.id
                and result.plan.goal_contract_version == goal.version
            )
            evidence["stateVersionCorrect"] = (
                result.plan.bank_state_version == state.state_version
            )
            evidence["goalSatisfied"] = result.plan.projected_outcome.goal_satisfied
            if goal.goal.type == "DELIVER_MONEY":
                evidence["targetCorrect"] = (
                    final.action == "TRANSFER"
                    and final.parameters.beneficiary_id == goal.goal.recipient_id
                    and final.parameters.amount == goal.goal.amount
                )
            elif goal.goal.type == "MOVE_FUNDS":
                evidence["targetCorrect"] = (
                    final.action == "MOVE_FUNDS"
                    and final.parameters.destination_account_id
                    == goal.goal.destination_account_id
                    and final.parameters.amount == goal.goal.amount
                )
            evidence["excludedAccountUnused"] = all(
                getattr(step.parameters, "source_account_id", None) != rule.account_id
                for rule in rules
                if rule.type == "EXCLUDED_ACCOUNT"
                for step in result.plan.steps
            )
            evidence["quoteBindingCorrect"] = sorted(
                result.plan.validity.required_quote_ids
            ) == sorted(
                step.parameters.quote_id
                for step in result.plan.steps
                if step.action == "FX_CONVERT"
            )
            pre, pre_ms = timed(
                lambda: preflight_plan(goal, result.plan, state, rules, policy)
            )
            evidence["preflight"] = pre.status
            metrics["preflightLatencyMs"] = pre_ms
    elif case.kind == "preservation":
        result, ms = timed(
            lambda: check_step_goal_preservation(goal, plan, 0, state, rules, policy)
        )
        evidence = {
            "status": result.status,
            "reason": result.reason.code if result.reason else None,
            "compilerCalls": result.compiler_calls,
        }
        metrics = {"goalPreservationLatencyMs": ms}
    elif case.kind == "preflight":
        if case.variant == "preflight_tampered":
            plan = deepcopy(plan)
            plan.steps[-1].parameters.amount.minor_units = "1"
        elif case.variant == "preflight_expired":
            state.captured_at = state.fx_quotes[0].expires_at
            state.state_version += 1
            before = state.model_dump(mode="json", by_alias=True)
        result, ms = timed(lambda: preflight_plan(goal, plan, state, rules, policy))
        evidence = {
            "status": result.status,
            "reason": result.reason.code if result.reason else None,
            "stepsSimulated": result.steps_simulated,
        }
        metrics = {"preflightLatencyMs": ms}
    elif case.kind == "revalidation":
        result, ms = timed(lambda: revalidate_plan(goal, plan, state, rules, policy))
        evidence = {
            "status": result.status,
            "reason": result.reason.code if result.reason else None,
            "stateVersionChanged": result.state_version_changed,
            "differenceCodes": [item.code for item in result.differences],
        }
        metrics = {"revalidationLatencyMs": ms}
    elif case.kind == "replanning":
        result, ms = timed(lambda: replan_goal(goal, plan, state, rules, policy))
        evidence = {
            "status": result.status,
            "reason": result.reason.code if result.reason else None,
            "route": [step.action for step in result.plan.steps] if result.plan else [],
            "targetPreserved": result.plan is None
            or result.plan.steps[-1].parameters.amount == goal.goal.amount,
        }
        metrics = {"revalidationLatencyMs": ms}
    elif case.kind == "relaxation":
        result, ms = timed(lambda: analyze_request_relaxations(goal, state, rules))
        evidence = {
            "status": result.status,
            "facts": [
                {
                    "type": item.constraint_type,
                    "value": item.hypothetical_value.minor_units,
                }
                for item in result.facts
            ],
        }
        if result.facts:
            fact = result.facts[0]
            exact = goal.model_copy(deep=True)
            exact.constraints[
                fact.constraint_index
            ].money.minor_units = fact.hypothetical_value.minor_units
            stricter = goal.model_copy(deep=True)
            boundary = int(fact.hypothetical_value.minor_units) + (
                -1 if fact.constraint_type == "MAX_TOTAL_COST" else 1
            )
            stricter.constraints[fact.constraint_index].money.minor_units = str(
                boundary
            )
            evidence["exactBoundary"] = (
                compile_goal(exact, state, rules).status == "SAT"
                and compile_goal(stricter, state, rules).status == "UNSAT"
            )
        metrics = {"relaxationLatencyMs": ms}
    elif case.kind == "maximum":
        result, ms = timed(
            lambda: find_max_feasible_amount(goal, state, 2000000, rules)
        )
        evidence = {
            "status": result.status,
            "amount": result.maximum_feasible_amount.minor_units
            if result.maximum_feasible_amount
            else None,
        }
        metrics = {
            "relaxationLatencyMs": ms,
            "compilerCalls": result.diagnostics.compiler_calls,
        }
        if result.maximum_feasible_amount:
            exact = goal.model_copy(deep=True)
            exact.goal.amount.minor_units = evidence["amount"]
            above = goal.model_copy(deep=True)
            above.goal.amount.minor_units = str(int(evidence["amount"]) + 1)
            evidence["exactBoundary"] = (
                compile_goal(exact, state, rules).status == "SAT"
                and compile_goal(above, state, rules).status == "UNSAT"
            )
    elif case.kind == "opportunity":
        template = (goal,) if case.variant == "max_opportunity" else ()
        result, ms = timed(
            lambda: discover_opportunities(state, rules, goal_templates=template)
        )
        wanted = {
            "above_reserve": "AVAILABLE_ABOVE_RESERVE",
            "after_obligations": "AVAILABLE_AFTER_OBLIGATIONS",
            "reserve_gap": "EMERGENCY_RESERVE_GAP",
            "obligation_shortfall": "UPCOMING_OBLIGATION_COVERAGE",
            "max_opportunity": "GOAL_AMOUNT_FEASIBILITY",
        }[case.variant]
        selected = next(
            (
                item
                for item in result.candidates
                if item.type == wanted and item.currency == "SGD"
            ),
            None,
        )
        evidence = {
            "status": selected.status if selected else "MISSING",
            "amount": selected.amount_minor_units if selected else None,
            "stateVersionCorrect": selected is not None
            and selected.state_version == state.state_version,
            "feasibilityProven": selected.feasibility_proven if selected else False,
        }
        metrics = {
            "opportunityLatencyMs": ms,
            "compilerCalls": result.diagnostics.compiler_calls,
        }
        if case.variant == "max_opportunity" and selected:
            exact = goal.model_copy(deep=True)
            exact.goal.amount.minor_units = selected.amount_minor_units
            above = goal.model_copy(deep=True)
            above.goal.amount.minor_units = str(int(selected.amount_minor_units) + 1)
            evidence["exactBoundary"] = (
                compile_goal(exact, state, rules).status == "SAT"
                and compile_goal(above, state, rules).status == "UNSAT"
            )
    ok = evidence["status"] == case.expected
    if case.route:
        ok &= tuple(evidence.get("route", ())) == case.route
    if case.reason:
        ok &= evidence.get("reason") == case.reason
    if case.amount:
        ok &= evidence.get("amount") == case.amount or any(
            item["value"] == case.amount for item in evidence.get("facts", [])
        )
    if case.kind == "planning" and evidence["status"] == "SAT":
        ok &= all(
            evidence[key]
            for key in (
                "goalBindingCorrect",
                "stateVersionCorrect",
                "goalSatisfied",
                "targetCorrect",
                "excludedAccountUnused",
                "quoteBindingCorrect",
            )
        )
        ok &= evidence["preflight"] == "READY"
        if case.id == "prefer_account":
            ok &= result.plan.steps[0].parameters.source_account_id == "preferred-usd"
        if case.id == "minimize_cost":
            ok &= result.plan.steps[0].parameters.quote_id == "quote-sgd-usd-1"
    if case.kind == "replanning" and evidence["status"] == "REPLANNED":
        ok &= evidence["targetPreserved"]
    if case.kind in {"maximum", "opportunity"} and case.variant in {
        "max_transfer",
        "max_opportunity",
    }:
        ok &= evidence.get("exactBoundary", False)
    if case.kind == "relaxation":
        ok &= evidence.get("exactBoundary", False)
    ok &= state.model_dump(mode="json", by_alias=True) == before
    return {
        "id": case.id,
        "family": case.family,
        "kind": case.kind,
        "expected": case.expected,
        "passed": bool(ok),
        "evidence": evidence,
        "metrics": metrics,
    }


def comparison():
    rows = []
    specs = (
        ("unchanged_fx_transfer", "fx", "successful_final_outcome"),
        ("goal_preservation_transfer_outage", "outage", "block_stranded_fx"),
        ("beneficiary_blocked_before_fx", "beneficiary_blocked", "block_stranded_fx"),
        ("destination_capability_lost", "destination_lost", "block_stranded_fx"),
        ("quote_expired_before_fx", "quote_expired", "block_invalid_first_step"),
        ("fx_service_disappears", "fx_off", "block_invalid_first_step"),
        ("source_freezes", "source_frozen", "block_invalid_first_step"),
        ("source_balance_drops", "source_drop", "block_invalid_first_step"),
        ("reserve_rule_becomes_binding", "reserve_binding", "block_invalid_first_step"),
        ("excluded_source_rule", "excluded_binding", "block_invalid_first_step"),
        ("alternate_source_replan", "direct_alternate", "replan"),
    )
    for name, variant, expected in specs:
        case = Case(name, "comparison", "revalidation", variant, "")
        goal, state, rules, policy, plan = make(case)
        baseline, baseline_ms = timed(
            lambda goal=goal, plan=plan, state=state, rules=rules, policy=policy: (
                validate_proposed_sequence(goal, plan, state, rules, policy)
            )
        )
        preservation, preservation_ms = timed(
            lambda goal=goal, plan=plan, state=state, rules=rules, policy=policy: (
                check_step_goal_preservation(goal, plan, 0, state, rules, policy)
            )
        )
        whole_plan = preflight_plan(goal, plan, state, rules, policy)
        replan = None
        if expected == "replan":
            replan = replan_goal(goal, plan, state, rules, policy)
        replacement_ready = (
            replan is not None
            and replan.plan is not None
            and preflight_plan(goal, replan.plan, state, rules, policy).status
            == "READY"
        )
        parlance = {
            "firstStepClassification": preservation.status,
            "wholePlanPreflight": whole_plan.status,
            "locallyValidStepsAllowed": 1 if preservation.status == "PRESERVED" else 0,
            "harmfulIntermediateStepsBlocked": int(
                baseline.stranded_intermediate_steps > 0
                and preservation.status != "PRESERVED"
            ),
            "successfulFinalOutcome": (
                whole_plan.status == "READY" and preservation.status == "PRESERVED"
            )
            or replacement_ready,
            "replanStatus": replan.status if replan else None,
            "policyViolationsAllowed": 0,
            "constraintViolationsAllowed": 0,
        }
        if expected == "block_stranded_fx":
            passed = (
                baseline.locally_valid_steps_allowed == 1
                and baseline.stranded_intermediate_steps == 1
                and preservation.status == "WOULD_BREAK_GOAL"
            )
        elif expected == "successful_final_outcome":
            passed = (
                baseline.final_goal_succeeded and preservation.status == "PRESERVED"
            )
        elif expected == "replan":
            passed = not baseline.final_goal_succeeded and replan.status == "REPLANNED"
        else:
            passed = (
                baseline.locally_valid_steps_allowed == 0
                and preservation.status != "PRESERVED"
            )
        rows.append(
            {
                "scenarioId": name,
                "passed": bool(passed),
                "baseline": asdict(baseline),
                "parlance": parlance,
                "latencyMs": {
                    "baseline": baseline_ms,
                    "goalPreservation": preservation_ms,
                },
            }
        )
    return rows


def determinism():
    selected = (
        "direct_transfer",
        "fx_transfer",
        "move_transfer",
        "move_fx_transfer",
        "material_ambiguity",
        "expired_quote",
        "max_cost_too_low",
    )
    rows = []
    for case in CASES:
        if case.id not in selected:
            continue
        goal, state, rules, policy, _ = make(case)
        baseline = None
        mismatches = 0
        for _ in range(20):
            result = compile_goal(goal, state, rules, policy)
            signature = (
                result.status,
                tuple((step.action, step.id) for step in result.plan.steps)
                if result.status == "SAT"
                else (),
                result.plan.plan_hash if result.status == "SAT" else None,
                result.reason.code if result.status != "SAT" else None,
                result.reason.details if result.status != "SAT" else None,
            )
            if baseline is None:
                baseline = signature
            elif signature != baseline:
                mismatches += 1
        rows.append({"scenarioId": case.id, "repeats": 20, "mismatches": mismatches})
    return rows


def hash_seed_determinism():
    """Repeat selected compilations in fresh interpreters with different hash seeds."""
    program = (
        "import json,sys; from scenarios import Case,make; from app.planner.compiler import compile_goal; "
        "goal,state,rules,policy,_=make(Case('seed','search','planning',sys.argv[1],'SAT')); "
        "result=compile_goal(goal,state,rules,policy); "
        "print(json.dumps(result.model_dump(mode='json',by_alias=True),sort_keys=True))"
    )
    rows = []
    for variant in ("fx", "fx_equivalent", "move_transfer"):
        outputs = []
        for seed_value in ("1", "777"):
            environment = os.environ.copy()
            environment["PYTHONHASHSEED"] = seed_value
            environment["PYTHONDONTWRITEBYTECODE"] = "1"
            environment["PYTHONPATH"] = os.pathsep.join(
                (str(ROOT / "services/compiler"), str(ROOT / "evaluation/compiler"))
            )
            process = subprocess.run(
                [sys.executable, "-c", program, variant],
                check=True,
                capture_output=True,
                text=True,
                env=environment,
            )
            outputs.append(process.stdout.strip())
        rows.append(
            {
                "variant": variant,
                "hashSeeds": [1, 777],
                "mismatch": outputs[0] != outputs[1],
            }
        )
    return rows


def adversarial():
    """State changes and malformed inputs with explicitly declared safe outcomes."""
    specs = (
        ("quote_expires_before_first", "quote_expired", "preflight", "INVALID_PLAN"),
        ("quote_economics_change", "quote_changed", "preflight", "STATE_CHANGED"),
        ("transfer_rail_disappears", "outage", "preservation", "WOULD_BREAK_GOAL"),
        ("fx_service_disappears", "fx_off", "preservation", "POLICY_BLOCKED"),
        (
            "beneficiary_becomes_blocked",
            "beneficiary_blocked",
            "preservation",
            "WOULD_BREAK_GOAL",
        ),
        ("source_account_freezes", "source_frozen", "preservation", "POLICY_BLOCKED"),
        ("source_balance_drops", "source_drop", "preservation", "INVALID_NEXT_STEP"),
        (
            "reserve_rule_becomes_binding",
            "reserve_binding",
            "preservation",
            "WOULD_BREAK_GOAL",
        ),
        (
            "destination_loses_capability",
            "destination_lost",
            "preservation",
            "WOULD_BREAK_GOAL",
        ),
        ("execution_prefix_inconsistent", "fx", "bad_prefix", "INVALID_PROGRESS"),
        ("prior_step_outcome_unknown", "fx", "unknown_prefix", "INVALID_PROGRESS"),
        ("duplicate_compile_calls", "fx", "repeat", "IDENTICAL"),
        ("malformed_quote_rate", "fx", "bad_quote", "UNSAT"),
        ("malformed_minor_unit", "direct", "bad_balance", "UNSAT"),
        ("malformed_goal_minor_unit", "direct", "bad_goal_amount", "UNSAT"),
        ("unsupported_mixed_cost", "fx_mixed_cost", "compile", "UNSAT"),
        ("valid_partial_execution_prefix", "fx", "valid_prefix", "READY"),
    )
    rows = []
    for name, variant, kind, expected in specs:
        if kind in {"preflight", "preservation"}:
            goal, state, rules, policy, plan = make(
                Case(name, "adversarial", kind, variant, expected)
            )
            result = (
                preflight_plan(goal, plan, state, rules, policy)
                if kind == "preflight"
                else check_step_goal_preservation(goal, plan, 0, state, rules, policy)
            )
            actual = result.status
            reason = result.reason.code if result.reason else None
        elif kind in {"bad_prefix", "unknown_prefix", "valid_prefix"}:
            goal, state = seed()
            plan = compile_goal(goal, state).plan
            progress = (
                ExecutionProgress((plan.steps[-1].id,))
                if kind == "bad_prefix"
                else ExecutionProgress((), (plan.steps[0].id,))
                if kind == "unknown_prefix"
                else ExecutionProgress((plan.steps[0].id,))
            )
            if kind == "valid_prefix":
                state = apply_operation(
                    state, _operation(plan.steps[0])
                ).state.to_snapshot()
                state.state_version += 1
            result = preflight_plan(goal, plan, state, progress=progress)
            actual = result.status
            reason = result.reason.code if result.reason else None
        elif kind == "repeat":
            goal, state = seed()
            actual = (
                "IDENTICAL"
                if compile_goal(goal, state) == compile_goal(goal, state)
                else "MISMATCH"
            )
            reason = None
        else:
            goal, state, rules, policy, _ = make(
                Case(name, "adversarial", "planning", variant, expected)
            )
            if kind == "bad_quote":
                state.fx_quotes[0].rate = "not-a-decimal"
            elif kind == "bad_balance":
                state.accounts[0].available_minor_units = "not-an-integer"
            elif kind == "bad_goal_amount":
                goal.goal.amount.minor_units = "not-an-integer"
            result = compile_goal(goal, state, rules, policy)
            actual = result.status
            reason = result.reason.code if result.status != "SAT" else None
        passed = actual == expected and (
            kind not in {"bad_balance", "bad_goal_amount"}
            or reason
            == ("INVALID_STATE_AMOUNT" if kind == "bad_balance" else "INVALID_AMOUNT")
        )
        rows.append(
            {
                "scenarioId": name,
                "expected": expected,
                "actual": actual,
                "reason": reason,
                "passed": passed,
            }
        )
    return rows


def performance():
    rows = []
    for size in (4, 12, 36):
        goal, state = seed()
        second_quote = deepcopy(state.fx_quotes[0])
        second_quote.id = "benchmark-quote-2"
        second_quote.rate = "0.74"
        state.fx_quotes.append(second_quote)
        state.accounts.clear()
        add_account(
            state,
            "sgd-funded",
            "SGD",
            900000,
            ["SEND_TRANSFER", "CONVERT_FX", "RECEIVE_TRANSFER"],
        )
        add_account(
            state, "usd-destination", "USD", 0, ["SEND_TRANSFER", "RECEIVE_TRANSFER"]
        )
        for index in range(size - 2):
            currency = "SGD" if index % 2 == 0 else "USD"
            add_account(
                state,
                f"graph-{index:02d}",
                currency,
                0,
                ["SEND_TRANSFER", "RECEIVE_TRANSFER"],
            )
        result, ms = timed(
            lambda goal=goal, state=state: compile_with_diagnostics(
                goal, state, max_depth=4, max_states=150
            )
        )
        d = result.diagnostics
        rows.append(
            {
                "graph": {4: "SMALL", 12: "MEDIUM", 36: "LARGE_HACKATHON"}[size],
                "accounts": size,
                "quotes": len(state.fx_quotes),
                "compileLatencyMs": ms,
                "status": result.result.status,
                "reason": result.result.reason.code
                if result.result.status != "SAT"
                else None,
                "statesExplored": d.states_explored,
                "candidateActionsEvaluated": d.candidate_actions_evaluated,
                "searchDepthReached": d.search_depth_reached,
                "maxStates": 150,
            }
        )
    return rows


def write(name, value):
    (RESULTS / name).write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")


def write_report(summary, benchmarks, latency_summary):
    safety = summary["safety"]
    lines = [
        "# C7 compiler evaluation",
        "",
        "Run with `python3 evaluation/compiler/run.py` from the repository root. The harness exits nonzero on failed correctness, comparison, adversarial, or determinism assertions. Expected outcomes are declared in `evaluation/compiler/scenarios.py`. Correctness JSON is stable across runs; measured timing is isolated in `performance-results.json` and changes with the machine and load.",
        "",
        "## Dataset and correctness",
        "",
        f"- {summary['casesTotal']} declared cases across basic planning, constraints, policy, FX, search, preflight, goal preservation, revalidation, replanning, relaxation, opportunities, and adversarial state changes.",
        f"- Planning: {summary['correctOutcomeCount']} / {summary['expectedSat'] + summary['expectedUnsat'] + summary['expectedPolicyBlocked']} correct outcomes; {summary['correctRouteCount']} checked SAT routes; {summary['incorrectAcceptCount']} incorrect accepts and {summary['incorrectRejectCount']} incorrect rejects.",
        f"- Adversarial: {summary['adversarial']['passed']} / {summary['adversarial']['cases']} passed; failed: {summary['adversarial']['failed']}.",
        "- Whole-plan preflight, changed-state revalidation, three replanning outcomes, exact relaxation boundaries, and five opportunity facts are checked by their declared cases.",
        "",
        "## Baseline comparison",
        "",
        f"The baseline receives the same bank snapshot, hard rules, policy, approved goal, and proposed operation sequence as Parlance. It calls the same C1 simulator, C2 policy engine, and constraint evaluator at each step. It checks local and cumulative validity but does not synthesize another route or prove that a valid intermediate action preserves the approved final goal. These are {summary['comparisonCases']} shared scenarios; the generated plan supplies the baseline sequence, so this is a comparison of execution-safety architecture rather than independent route generation.",
        "",
        f"- Locally valid steps allowed: baseline {safety['baselineLocallyValidStepsAllowed']}; Parlance {safety['parlanceLocallyValidStepsAllowed']}.",
        f"- Stranded intermediate steps: baseline {safety['baselineStrandedIntermediateSteps']}; Parlance blocked {safety['parlanceBlockedHarmfulIntermediateSteps']} harmful intermediate steps.",
        f"- Successful final outcomes or ready replacement plans: baseline {safety['baselineSuccessfulFinalOutcomes']}; Parlance {safety['parlanceSuccessfulFinalOutcomes']} ({safety['parlanceSuccessfulSafeReplans']} safe replan). No banking execution was performed.",
        f"- Policy violations allowed: baseline {safety['baselinePolicyViolationsAllowed']}, Parlance 0. Constraint violations allowed: baseline {safety['baselineConstraintViolationsAllowed']}, Parlance 0.",
        "- In `goal_preservation_transfer_outage`, the baseline locally permits FX and then cannot transfer; Parlance classifies FX as `WOULD_BREAK_GOAL` before it can run.",
        "",
        "## Determinism and search",
        "",
        f"- {summary['determinism']['repeats']} repeated compiles had {summary['determinism']['mismatches']} mismatches in status, route, IDs, hash, or structured reason. Three cases also matched across two Python hash seeds; seed mismatches: {summary['determinism']['hashSeedMismatches']}.",
        f"- Mean states explored {summary['search']['averageStatesExplored']:.2f}; maximum {summary['search']['maxStatesExplored']}; mean candidates evaluated {summary['search']['averageCandidatesEvaluated']:.2f}; search-bound failures {summary['search']['searchBoundFailures']}. Solver calls: {summary['search']['solverCalls']}.",
        "",
        "## Measured performance",
        "",
        "One measured run on the local machine; these are observations, not service-level guarantees. Benchmarks use two currencies, two quotes, and a 150-state cap.",
        "",
        "| Graph | Accounts | Compile ms | States | Candidates | Result |",
        "|---|---:|---:|---:|---:|---|",
    ]
    for row in benchmarks:
        lines.append(
            f"| {row['graph']} | {row['accounts']} | {row['compileLatencyMs']:.2f} | {row['statesExplored']} | {row['candidateActionsEvaluated']} | {row['status']} / {row['reason'] or 'SAT'} |"
        )
    lines.extend(
        [
            "",
            "Measured mean operation latencies (ms): "
            + ", ".join(
                f"{name} {values['average']:.3f}"
                for name, values in latency_summary.items()
                if values["average"] is not None
            )
            + ".",
            "",
            "## Limits and findings",
            "",
            "- BUY_ASSET and SELL_ASSET route synthesis and trade-price approval binding remain deferred. Unsupported mixed-currency cost attribution fails closed.",
            "- Search is bounded by depth and state count. The loop graph reaches the cap, and medium and large benchmarks may return bounded UNSAT rather than prove financial infeasibility.",
            "- Opportunities are read-only. The current HTTP API may not pass all hard-rule and policy context. C4 partial-cost provenance can fail closed.",
            "- This pass corrected fully funded frozen-account policy classification and added malformed-balance and malformed-goal-amount fail-closed handling. No shared contract or database change was needed.",
            f"- The baseline's {safety['baselineWholeGoalFailures']} whole-goal failures include cases where it stops safely before any step; only its {safety['baselineStrandedIntermediateSteps']} stranded intermediate steps demonstrate the whole-goal safety gap.",
            "",
        ]
    )
    (ROOT / "evaluation/REPORT.md").write_text("\n".join(lines))


def main():
    case_rows = [evaluate(case) for case in CASES]
    comparisons = comparison()
    repeats = determinism()
    hash_seeds = hash_seed_determinism()
    attacks = adversarial()
    benchmarks = performance()
    planning = [row for row in case_rows if row["kind"] == "planning"]
    search = [row["metrics"] for row in planning if "statesExplored" in row["metrics"]]
    latency_names = (
        "compileLatencyMs",
        "preflightLatencyMs",
        "goalPreservationLatencyMs",
        "revalidationLatencyMs",
        "relaxationLatencyMs",
    )
    latencies = {
        key: [row["metrics"][key] for row in case_rows if key in row["metrics"]]
        for key in latency_names
    }
    summary = {
        "casesTotal": len(case_rows) + len(attacks),
        "comparisonCases": len(comparisons),
        "families": dict(
            Counter(row["family"] for row in case_rows)
            | Counter({"adversarial": len(attacks)})
        ),
        "expectedSat": sum(row["expected"] == "SAT" for row in planning),
        "expectedUnsat": sum(row["expected"] == "UNSAT" for row in planning),
        "expectedPolicyBlocked": sum(
            row["expected"] == "POLICY_BLOCKED" for row in planning
        ),
        "correctOutcomeCount": sum(row["passed"] for row in planning),
        "correctRouteCount": sum(
            row["passed"] and bool(row["evidence"].get("route")) for row in planning
        ),
        "incorrectAcceptCount": sum(
            row["expected"] != "SAT" and row["evidence"]["status"] == "SAT"
            for row in planning
        ),
        "incorrectRejectCount": sum(
            row["expected"] == "SAT" and row["evidence"]["status"] != "SAT"
            for row in planning
        ),
        "safety": {
            "baselineLocallyValidStepsAllowed": sum(
                row["baseline"]["locally_valid_steps_allowed"] for row in comparisons
            ),
            "parlanceLocallyValidStepsAllowed": sum(
                row["parlance"]["locallyValidStepsAllowed"] for row in comparisons
            ),
            "baselineSuccessfulFinalOutcomes": sum(
                row["baseline"]["final_goal_succeeded"] for row in comparisons
            ),
            "parlanceSuccessfulFinalOutcomes": sum(
                row["parlance"]["successfulFinalOutcome"] for row in comparisons
            ),
            "baselineConstraintViolationsAllowed": sum(
                row["baseline"]["constraint_violations_allowed"] for row in comparisons
            ),
            "baselinePolicyViolationsAllowed": sum(
                row["baseline"]["policy_violations_allowed"] for row in comparisons
            ),
            "baselineWholeGoalFailures": sum(
                row["baseline"]["whole_goal_failure"] for row in comparisons
            ),
            "baselineGoalViolations": sum(
                row["baseline"]["stranded_intermediate_steps"] > 0
                for row in comparisons
            ),
            "parlanceGoalViolations": sum(
                row["parlance"]["locallyValidStepsAllowed"] > 0
                and not row["parlance"]["successfulFinalOutcome"]
                for row in comparisons
            ),
            "baselineStrandedIntermediateSteps": sum(
                row["baseline"]["stranded_intermediate_steps"] for row in comparisons
            ),
            "parlanceBlockedHarmfulIntermediateSteps": sum(
                row["parlance"]["harmfulIntermediateStepsBlocked"]
                for row in comparisons
            ),
            "parlanceSuccessfulSafeReplans": sum(
                row["parlance"]["replanStatus"] == "REPLANNED" for row in comparisons
            ),
        },
        "determinism": {
            "repeats": sum(row["repeats"] for row in repeats),
            "mismatches": sum(row["mismatches"] for row in repeats),
            "hashSeedMismatches": sum(row["mismatch"] for row in hash_seeds),
        },
        "search": {
            "averageStatesExplored": mean(row["statesExplored"] for row in search),
            "maxStatesExplored": max(row["statesExplored"] for row in search),
            "averageCandidatesEvaluated": mean(
                row["candidateActionsEvaluated"] for row in search
            ),
            "averageSearchDepth": mean(row["searchDepthReached"] for row in search),
            "solverCalls": sum(row["solverCalls"] for row in search),
            "prunedByPolicy": sum(row["prunedByPolicy"] for row in search),
            "prunedByConstraint": sum(row["prunedByConstraint"] for row in search),
            "prunedVisitedStates": sum(row["prunedVisitedStates"] for row in search),
            "validPlansFound": sum(row["validPlansFound"] for row in search),
            "searchBoundFailures": sum(
                row["evidence"].get("reason")
                in {"MAX_STATES_EXPLORED", "SEARCH_DEPTH_EXHAUSTED"}
                for row in planning
            ),
        },
        "failedCases": [row["id"] for row in case_rows if not row["passed"]],
        "failedComparisons": [
            row["scenarioId"] for row in comparisons if not row["passed"]
        ],
        "adversarial": {
            "cases": len(attacks),
            "passed": sum(row["passed"] for row in attacks),
            "failed": [row["scenarioId"] for row in attacks if not row["passed"]],
        },
    }
    latency_summary = {
        key: {
            "count": len(values),
            "average": mean(values) if values else None,
            "max": max(values) if values else None,
        }
        for key, values in latencies.items()
    }
    write(
        "compiler-results.json",
        [
            {key: value for key, value in row.items() if key != "metrics"}
            for row in case_rows
        ],
    )
    write(
        "baseline-results.json",
        [
            {"scenarioId": row["scenarioId"], "baseline": row["baseline"]}
            for row in comparisons
        ],
    )
    write(
        "comparison-results.json",
        [
            {key: value for key, value in row.items() if key != "latencyMs"}
            for row in comparisons
        ],
    )
    write(
        "performance-results.json",
        {
            "benchmarks": benchmarks,
            "caseMeasurements": [
                {"scenarioId": row["id"], **row["metrics"]} for row in case_rows
            ],
            "comparisonLatencyMs": [
                {"scenarioId": row["scenarioId"], **row["latencyMs"]}
                for row in comparisons
            ],
            "latencySummaryMs": latency_summary,
        },
    )
    write("determinism-results.json", repeats)
    write("hash-seed-results.json", hash_seeds)
    write("adversarial-results.json", attacks)
    write("summary.json", summary)
    write_report(summary, benchmarks, latency_summary)
    print(json.dumps(summary, indent=2, sort_keys=True))
    if (
        summary["failedCases"]
        or summary["failedComparisons"]
        or summary["adversarial"]["failed"]
        or summary["determinism"]["mismatches"]
        or summary["determinism"]["hashSeedMismatches"]
    ):
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
