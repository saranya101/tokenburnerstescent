import { expect, it } from "vitest";
import { reconcileBankExecution } from "./reconciliation.js";

it("keeps unknown bank outcomes unknown for later reconciliation", async () => {
  expect(await reconcileBankExecution({ accepted: true })).toBe("UNKNOWN");
  expect(await reconcileBankExecution({ accepted: false })).toBe("FAILED");
});
