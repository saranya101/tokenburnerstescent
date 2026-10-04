import { expect, it } from "vitest";
import { createBrowserExecutionResumeStore } from "./use-customer-flow";

it("imports and constructs the browser recovery adapter without requiring window", () => {
  expect(typeof window).toBe("undefined");
  const store = createBrowserExecutionResumeStore();
  expect(() => store.load()).not.toThrow();
  expect(store.load()).toBeUndefined();
});
