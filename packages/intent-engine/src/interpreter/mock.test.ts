import { expect, it } from "vitest";
import { MockIntentInterpreter, MockIntentBundleInterpreter } from "./mock.js";

it.each([
  ["send 20000 to john", "john", "2000000"],
  ["send 100 to John Lim", "John Lim", "10000"],
  ["send hundred dollars to John", "John", "10000"],
])("preserves amount and recipient without assuming currency: %s", async (text, recipientReference, minorUnits) => {
  const draft = await new MockIntentInterpreter().interpretUserRequest({ text, userId: "u1" });
  expect(draft.goal).toEqual({ type: "DELIVER_MONEY", amount: { minorUnits }, recipientReference });
  expect(JSON.stringify(draft)).not.toContain("UNRESOLVED");
});

it.each(["SGD", "USD"])("preserves explicit %s", async (currency) => {
  const draft = await new MockIntentInterpreter().interpretUserRequest({ text: `Send ${currency} 100 to John Lim.`, userId: "u1" });
  expect(draft.goal).toMatchObject({ amount: { currency, minorUnits: "10000" }, recipientReference: "John Lim" });
});

it("does not invent a recipient or an absent amount", async () => {
  expect((await new MockIntentInterpreter().interpretUserRequest({ text: "send money", userId: "u1" })).goal).toEqual({ type: "DELIVER_MONEY" });
});

it("preserves one Apple share without inventing a canonical ID", async () => {
  expect((await new MockIntentInterpreter().interpretUserRequest({ text: "Buy one share of Apple.", userId: "u1" })).goal).toEqual({ type: "ACQUIRE_ASSET", quantity: "1", assetReference: "Apple" });
});

it("preserves exactly two headline actions, conditional funding and the SGD reserve", async () => {
  const text = "Okay send hundred dollars to John Lim and then buy one share of Apple stock and use SGD if needed but at least keep $1000 in my SGD account.";
  const bundle = await new MockIntentBundleInterpreter().interpretUserRequest({ text, userId: "u1" });
  expect(bundle.items.map((item) => item.goal.type)).toEqual(["DELIVER_MONEY", "ACQUIRE_ASSET"]);
  expect(bundle.items[0]?.goal).toMatchObject({ recipientReference: "John Lim", amount: { minorUnits: "10000" } });
  expect(bundle.items[1]?.goal).toEqual({ type: "ACQUIRE_ASSET", quantity: "1", assetReference: "Apple" });
  expect(bundle.items[1]?.preferences).toEqual([{ type: "PREFER_ACCOUNT", accountReference: "SGD" }]);
  expect(bundle.globalConstraints).toEqual([{ type: "MIN_AVAILABLE_BALANCE", money: { currency: "SGD", minorUnits: "100000" }, accountReference: "my SGD account" }]);
  expect(bundle.explicitDependencies).toHaveLength(1);
});

it.each(["hello", "do not send SGD 100 to John", "send SGD 100 to John and send SGD 20 to Jane"])("fails closed for unsupported single requests: %s", async (text) => {
  await expect(new MockIntentInterpreter().interpretUserRequest({ text, userId: "u1" })).rejects.toThrow();
});


it.each([
  ["Convert SGD 100 to USD", "DEMO_FX_UNAVAILABLE"],
  ["Pay my electricity bill", "DEMO_BILL_UNAVAILABLE"],
  ["Hello", "DEMO_REQUEST_UNSUPPORTED"],
])("returns a capability refusal instead of a provider outage: %s", async (text, code) => {
  await expect(new MockIntentInterpreter().interpretUserRequest({ text, userId: "u1" })).rejects.toMatchObject({ code });
});
it("does not silently omit an unavailable action in a bundle", async () => {
  await expect(new MockIntentBundleInterpreter().interpretUserRequest({ text: "Send SGD 100 to John and pay my electricity bill", userId: "u1" })).rejects.toMatchObject({ code: "DEMO_BILL_UNAVAILABLE" });
});
it("does not mistake a payee name for an FX instruction", async () => {
  expect((await new MockIntentInterpreter().interpretUserRequest({ text: "Send SGD 100 to Exchange", userId: "u1" })).goal).toMatchObject({ type: "DELIVER_MONEY", recipientReference: "Exchange" });
});
it("refuses a mixed request containing an unsupported conversion", async () => {
  await expect(new MockIntentBundleInterpreter().interpretUserRequest({ text: "Send SGD 100 to John and then convert SGD 50 to USD", userId: "u1" })).rejects.toMatchObject({ code: "DEMO_FX_UNAVAILABLE" });
});

it("preserves company punctuation and ticker in the investment shortcut", async () => {
  expect((await new MockIntentInterpreter().interpretUserRequest({ text: "Buy 1 share of Apple Inc. (AAPL).", userId: "u1" })).goal).toEqual({ type: "ACQUIRE_ASSET", quantity: "1", assetReference: "Apple Inc. (AAPL)" });
});
