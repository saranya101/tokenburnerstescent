export type DemoAccount = {
  name: string;
  number: string;
  balance: string;
  currency: string;
};

export type DemoActivity = {
  merchant: string;
  date: string;
  amount: string;
  kind: "credit" | "debit";
  category: string;
  initials: string;
};

// Display-only banking context. Nothing in this file is persisted or sent to an API.
export const demoBankingData = {
  customerName: "Alex",
  totalBalance: "S$24,830.40",
  accounts: [
    { name: "Multiplier Account", number: "•••• 4918", balance: "18,420.40", currency: "SGD" },
    { name: "Savings", number: "•••• 2872", balance: "6,410.00", currency: "SGD" },
    { name: "USD Wallet", number: "•••• 1104", balance: "4,750.00", currency: "USD" },
  ] satisfies DemoAccount[],
  investmentValue: "S$24,680.15",
  investmentChange: "+2.4% this month",
  activity: [
    { merchant: "Salary", date: "Today, 09:15", amount: "+S$4,850.00", kind: "credit", category: "Income", initials: "SA" },
    { merchant: "NTUC FairPrice", date: "Yesterday, 18:42", amount: "−S$84.20", kind: "debit", category: "Groceries", initials: "NF" },
    { merchant: "Apple", date: "20 Sep, 14:08", amount: "−S$18.98", kind: "debit", category: "Services", initials: "AP" },
    { merchant: "Grab", date: "19 Sep, 08:21", amount: "−S$24.60", kind: "debit", category: "Transport", initials: "GR" },
  ] satisfies DemoActivity[],
  cashflow: [{ label: "W1", inflow: 72, outflow: 34 }, { label: "W2", inflow: 46, outflow: 52 }, { label: "W3", inflow: 82, outflow: 39 }, { label: "W4", inflow: 61, outflow: 44 }],
};
