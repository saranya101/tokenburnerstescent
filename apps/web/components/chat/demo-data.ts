export type GoalDetail = { label: string; value: string };
export type GoalSummary = {
  eyebrow: string;
  title: string;
  description: string;
  details: GoalDetail[];
  constraints: string[];
  preferences: string[];
};

export type PlanStep = {
  id: string;
  kind: string;
  title: string;
  summary: string;
  meta: Array<{ label: string; value: string }>;
  dependsOn?: string;
};

export type DemoScenario = {
  goal: GoalSummary;
  planTitle: string;
  planSummary: string;
  steps: PlanStep[];
  preservedConstraints: string[];
  outcome: "success" | "safe-stop";
};

const ntuScenario: DemoScenario = {
  goal: {
    eyebrow: "Send money",
    title: "Send US$5,000 to NTU",
    description: "A one-time transfer to your confirmed NTU beneficiary.",
    details: [{ label: "Recipient", value: "NTU" }, { label: "Amount", value: "US$5,000" }],
    constraints: ["Keep at least S$1,000 available"],
    preferences: ["Use the lowest-cost valid route"],
  },
  planTitle: "One safe transfer",
  planSummary: "Funds leave your USD account only after the latest balance and beneficiary status are checked.",
  steps: [{ id: "transfer", kind: "Transfer", title: "Send US$5,000", summary: "USD Wallet → NTU", meta: [{ label: "Source", value: "USD Wallet" }, { label: "Recipient", value: "NTU" }] }],
  preservedConstraints: ["S$1,000 minimum available balance preserved"],
  outcome: "success",
};

const appleScenario: DemoScenario = {
  goal: {
    eyebrow: "Buy an asset",
    title: "Use S$2,000 to buy Apple",
    description: "Convert Singapore dollars to USD, then purchase Apple shares within the confirmed budget.",
    details: [{ label: "Asset", value: "Apple · AAPL" }, { label: "Budget", value: "S$2,000 maximum" }],
    constraints: ["Do not spend more than S$2,000"],
    preferences: ["Use the current eligible FX route"],
  },
  planTitle: "Convert, then buy",
  planSummary: "The purchase depends on the conversion settling first. Both steps remain bound to this exact route.",
  steps: [
    { id: "convert", kind: "Convert", title: "S$2,000 → US$1,500", summary: "Everyday Account → USD Wallet", meta: [{ label: "Current quote", value: "S$1 = US$0.75" }, { label: "Maximum debit", value: "S$2,000" }] },
    { id: "buy", kind: "Buy", title: "Apple (AAPL)", summary: "USD Wallet → Investment holding", dependsOn: "Conversion completed", meta: [{ label: "Funding", value: "Up to US$1,500" }, { label: "Settlement", value: "USD" }] },
  ],
  preservedConstraints: ["S$2,000 hard spending limit preserved", "Purchase occurs only after conversion settles"],
  outcome: "safe-stop",
};

const savingsScenario: DemoScenario = {
  goal: {
    eyebrow: "Move money",
    title: "Move S$500 into savings",
    description: "An internal transfer between your own accounts.",
    details: [{ label: "Destination", value: "Emergency Savings" }, { label: "Amount", value: "S$500" }],
    constraints: ["Use an eligible SGD source account"],
    preferences: [],
  },
  planTitle: "One internal transfer",
  planSummary: "Move funds directly between your eligible SGD accounts.",
  steps: [{ id: "move", kind: "Move", title: "S$500", summary: "Everyday Account → Emergency Savings", meta: [{ label: "Source", value: "Everyday Account" }, { label: "Destination", value: "Emergency Savings" }] }],
  preservedConstraints: ["Accounts and currency verified before movement"],
  outcome: "success",
};

export const suggestions = [
  "Send NTU US$5,000 and keep S$1,000 available",
  "Convert S$2,000 to USD and use it to buy Apple",
  "Move S$500 into my savings account",
];

export function scenarioFor(message: string): DemoScenario {
  const normalized = message.toLowerCase();
  if (normalized.includes("apple") || normalized.includes("aapl")) return appleScenario;
  if (normalized.includes("saving") || normalized.includes("move")) return savingsScenario;
  return ntuScenario;
}
