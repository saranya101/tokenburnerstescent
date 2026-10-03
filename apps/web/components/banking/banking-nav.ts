import type { IconName } from "../ui/icon";

export type BankingSection = "home" | "accounts" | "pay" | "cards" | "invest" | "parlance" | "settings";
export type BankingNavItem = { id: BankingSection; label: string; href: string; icon: IconName };

export const customerDesktopNavigation: BankingNavItem[] = [
  { id: "home", label: "Home", href: "/", icon: "home" },
  { id: "accounts", label: "Accounts", href: "/accounts", icon: "accounts" },
  { id: "cards", label: "Cards", href: "/#accounts", icon: "card" },
  { id: "invest", label: "Invest", href: "/invest", icon: "invest" },
  { id: "parlance", label: "Pay & Transfer", href: "/chat", icon: "transfer" },
];

export const customerMobileNavigation = ["home", "parlance", "accounts", "invest"].map((id) => customerDesktopNavigation.find((item) => item.id === id)!).filter(Boolean);
