import { describe, expect, it } from "vitest";
import { parseOpsRuns, redactForDisplay } from "./ops-read-model";

describe("ops presentation boundary", () => {
  it("sorts audit events chronologically", () => {
    const stage = { state: "NOT_REACHED", summary: "none" };
    const [run] = parseOpsRuns([{ id: "run", occurredAt: "2026-09-29T00:00:00Z", headline: "request", overallState: "WAITING", stages: { request: { state: "COMPLETE", summary: "recorded" }, interpretation: { state: "COMPLETE", summary: "parsed" }, semanticValidation: { state: "COMPLETE", summary: "validated" }, confirmedGoal: stage, plan: stage, authorization: stage, execution: stage, bankResult: stage }, audit: [
      { id: "later", eventType: "LATER", occurredAt: "2026-09-29T00:02:00Z", aggregateType: "Run", aggregateId: "run", traceId: "trace", metadata: {} },
      { id: "earlier", eventType: "EARLIER", occurredAt: "2026-09-29T00:01:00Z", aggregateType: "Run", aggregateId: "run", traceId: "trace", metadata: {} },
    ] }]);
    expect(run?.audit.map((event) => event.id)).toEqual(["earlier", "later"]);
  });

  it("redacts forbidden authentication and provider fields as defense in depth", () => {
    expect(redactForDisplay({ prompt: "secret prompt", credentialPublicKey: "bytes", providerBody: { raw: true }, safe: "visible", note: "Bearer token-value" })).toEqual({ prompt: "[redacted]", credentialPublicKey: "[redacted]", providerBody: "[redacted]", safe: "visible", note: "[redacted]" });
  });

  it("drops malformed runs instead of fabricating missing stages", () => {
    expect(parseOpsRuns([{ id: "partial", headline: "request", stages: {} }])).toEqual([]);
  });
});
