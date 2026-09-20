import { expect, it } from "vitest";
import { MockIntentInterpreter } from "./mock.js";
it("returns a validated goal-only draft", async () => {
  const draft = await new MockIntentInterpreter().interpretUserRequest({ text: "send 25", userId: "u1" });
  expect(draft.goal.type).toBe("DELIVER_MONEY");
  expect("actions" in draft).toBe(false);
});
