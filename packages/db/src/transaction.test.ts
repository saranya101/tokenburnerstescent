import { expect, it } from "vitest";
import { transitionExecutionWithOutbox, type TransactionRunner, type TransactionalWriter } from "./index.js";

interface State { status: string; audits: string[]; outbox: string[] }
function runner(state: State, failAt?: "audit" | "outbox"): TransactionRunner {
  return { async transaction(work) { const draft = structuredClone(state); const writer: TransactionalWriter = {
    async updateExecution(_id, status) { draft.status = status; },
    async appendAudit(event) { if (failAt === "audit") throw new Error("audit failed"); draft.audits.push(event.type); },
    async insertOutbox(event) { if (failAt === "outbox") throw new Error("outbox failed"); draft.outbox.push(event.topic); },
  }; const result = await work(writer); Object.assign(state, draft); return result; } };
}
const input = { executionId: "run-1", nextStatus: "EXECUTING", auditType: "EXECUTION_STARTED", traceId: "trace-1", payload: {}, outboxTopic: "EXECUTION_STARTED" };

it("commits execution, audit, and outbox together", async () => { const state = { status: "AUTHORIZED", audits: [], outbox: [] } satisfies State; await transitionExecutionWithOutbox(runner(state), input); expect(state).toEqual({ status: "EXECUTING", audits: ["EXECUTION_STARTED"], outbox: ["EXECUTION_STARTED"] }); });
it.each(["audit", "outbox"] as const)("rolls back every record when %s insertion fails", async (failAt) => { const state = { status: "AUTHORIZED", audits: [], outbox: [] } satisfies State; await expect(transitionExecutionWithOutbox(runner(state, failAt), input)).rejects.toThrow(); expect(state).toEqual({ status: "AUTHORIZED", audits: [], outbox: [] }); });
