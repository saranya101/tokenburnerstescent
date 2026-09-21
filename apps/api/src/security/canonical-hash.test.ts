import { expect, it } from "vitest";
import { canonicalHash, canonicalJson } from "./canonical-hash.js";

it("canonicalizes object keys while preserving array order", () => {
  expect(canonicalJson({ z: 1, a: { y: 2, x: 3 } })).toBe('{"a":{"x":3,"y":2},"z":1}');
  expect(canonicalHash({ a: 1, b: 2 })).toBe(canonicalHash({ b: 2, a: 1 }));
  expect(canonicalHash({ a: [1, 2] })).not.toBe(canonicalHash({ a: [2, 1] }));
});
