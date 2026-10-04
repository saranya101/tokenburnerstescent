import { describe, expect, it } from "vitest";
import { sourceActionSignals, sourceSupportsMoney, sourceSupportsQuantity } from "./evidence.js";

describe("deterministic source evidence", () => {
  it.each(["Send John $100", "Transfer $300 to John", "Buy Apple with a budget of $500"])(
    "does not let a bare dollar symbol support USD or SGD: %s",
    (sourceText) => {
      expect(sourceSupportsMoney(sourceText, { currency: "USD", minorUnits: sourceText.includes("100") ? "10000" : sourceText.includes("300") ? "30000" : "50000" })).toBe(false);
      expect(sourceSupportsMoney(sourceText, { currency: "SGD", minorUnits: sourceText.includes("100") ? "10000" : sourceText.includes("300") ? "30000" : "50000" })).toBe(false);
    },
  );

  it.each([
    ["Send John USD 100", "USD"],
    ["Send John US$100", "USD"],
    ["Send John SGD 100", "SGD"],
    ["Send John S$100", "SGD"],
    ["Transfer 100 USD to John", "USD"],
  ] as const)("retains explicit currency evidence: %s", (sourceText, currency) => {
    expect(sourceSupportsMoney(sourceText, { currency, minorUnits: "10000" })).toBe(true);
  });

  it.each([
    ["Don't buy Apple. Send John USD 10.", ["DELIVER_MONEY"]],
    ["Do not send John anything. Buy one Apple share.", ["ACQUIRE_ASSET"]],
    ["Never pay Example Power.", []],
    ["You must not transfer USD 10 to John.", []],
    ["You should not buy Apple.", []],
    ["Please do not actually move SGD 10 to Savings.", []],
    ["I said \"buy Apple\" as an example, not an instruction.", []],
    ["I said buy Apple as an example, not an instruction.", []],
    ["Ignore the phrase \"send John USD 500\"; actually send Sarah USD 20.", ["DELIVER_MONEY"]],
    ["I told you not to buy Apple. Send John USD 10.", ["DELIVER_MONEY"]],
    ["I don't want to buy Apple. Send John USD 10.", ["DELIVER_MONEY"]],
    ["Do not try to send John anything. Buy one Apple share.", ["ACQUIRE_ASSET"]],
    ["You should not attempt to pay Example Power.", []],
    ["Never try to transfer from Savings.", []],
  ] as const)("excludes negated or non-instruction actions: %s", (sourceText, expected) => {
    expect(sourceActionSignals(sourceText).map(({ type }) => type)).toEqual(expected);
  });

  it("keeps ordinary positive financial actions", () => {
    expect(sourceActionSignals("Send John USD 10 and get one Apple share.").map(({ type }) => type))
      .toEqual(["DELIVER_MONEY", "ACQUIRE_ASSET"]);
  });

  it.each([
    ["Get one Apple share.", ["ACQUIRE_ASSET"]],
    ["Get two AAPL shares.", ["ACQUIRE_ASSET"]],
    ["Get 3 units of the fund.", ["ACQUIRE_ASSET"]],
    ["Get John to send USD 10 to Sarah.", ["DELIVER_MONEY"]],
    ["Get John to send USD 10, then buy one Apple share.", ["DELIVER_MONEY", "ACQUIRE_ASSET"]],
    ["Get Sarah to transfer SGD 20.", ["DELIVER_MONEY"]],
    ["Get the USD statement from John.", []],
    ["Get me the payment receipt.", []],
  ] as const)("requires actual asset context before get is an acquisition: %s", (sourceText, expected) => {
    expect(sourceActionSignals(sourceText).map(({ type }) => type)).toEqual(expected);
  });

  it.each([
    ["Buy 1 Apple share", "1"],
    ["Buy one Apple share", "1"],
    ["Buy 2 Apple shares", "2"],
    ["Buy two Apple shares", "2"],
    ["Buy 1.5 units", "1.5"],
    ["Acquire 3 shares", "3"],
  ])("proves explicit asset quantity evidence: %s", (sourceText, quantity) => {
    expect(sourceSupportsQuantity(sourceText, quantity)).toBe(true);
  });

  it("does not invent a quantity when the acquisition has none", () => {
    expect(sourceSupportsQuantity("Buy Apple", "10")).toBe(false);
  });

  it.each([
    "Buy Apple. I already own 10 shares.",
    "Buy Apple because I already own 10 shares.",
    "Buy Apple; my current holding is 10 shares.",
    "Buy Apple. The portfolio shows 10 shares.",
  ])("does not use background holdings as acquisition quantity: %s", (sourceText) => {
    expect(sourceSupportsQuantity(sourceText, "10")).toBe(false);
  });

  it.each([
    ["Buy 10 Apple shares.", "10"],
    ["Buy one Apple share.", "1"],
    ["Acquire 3 shares of Apple.", "3"],
    ["Buy 1.5 units of the fund.", "1.5"],
    ["Get two Apple shares.", "2"],
  ])("keeps instruction-local acquisition quantity evidence: %s", (sourceText, quantity) => {
    expect(sourceSupportsQuantity(sourceText, quantity)).toBe(true);
  });
});
