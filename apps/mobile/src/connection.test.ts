import { expect, it } from "vitest";
import { connectionConfigured } from "./connection";
it("needs only the HTTPS API origin and no external identity provider", () => {
  expect(connectionConfigured({ apiBaseUrl: "https://bank.example" })).toBe(true);
  for (const apiBaseUrl of ["", "http://bank.example", "https://bank.example/api/mobile", "https://user:pass@bank.example", "https://bank.example?target=evil"]) expect(connectionConfigured({ apiBaseUrl })).toBe(false);
});
