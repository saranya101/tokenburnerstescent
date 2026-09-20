from fastapi import FastAPI

from app.models.contracts import (
    CompileRequest,
    CompilerResultV1,
    OpportunitiesRequest,
    RevalidateRequest,
)
from app.planner.simple import compile_goal

app = FastAPI(title="Parlance Financial Compiler", version="0.0.0")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "compiler"}


@app.get("/ready")
def ready() -> dict[str, str]:
    return {"status": "ready"}


@app.post("/v1/compile", response_model=CompilerResultV1, response_model_by_alias=True)
def compile_endpoint(request: CompileRequest) -> CompilerResultV1:
    return compile_goal(request.goal_contract, request.bank_state_snapshot)


@app.post("/v1/revalidate")
def revalidate(request: RevalidateRequest) -> dict[str, object]:
    matches = request.financial_plan.bank_state_version == request.bank_state_snapshot.state_version
    # TODO: rerun operation preconditions and policy checks, not only version equality.
    return {
        "valid": matches,
        "requiresReplan": not matches,
        "stateVersion": request.bank_state_snapshot.state_version,
    }


@app.post("/v1/opportunities")
def opportunities(request: OpportunitiesRequest) -> list[dict[str, object]]:
    _ = request
    # TODO: deterministically evaluate hard rules and templates. Never auto-authorize.
    return []
