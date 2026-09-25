import type { IconName } from "../ui/icon";

export type BankingSection = "home" | "accounts" | "pay" | "cards" | "invest" | "parlance";
export type BankingNavItem = { id: BankingSection; label: string; href: string; icon: IconName };

export const customerDesktopNavigation: BankingNavItem[] = [
  { id: "home", label: "Home", href: "/", icon: "home" },
  { id: "accounts", label: "Accounts", href: "/#accounts", icon: "accounts" },
  { id: "pay", label: "Pay & Transfer", href: "/#actions", icon: "transfer" },
  { id: "cards", label: "Cards", href: "/#accounts", icon: "card" },
  { id: "invest", label: "Invest", href: "/#investments", icon: "invest" },
  { id: "parlance", label: "Parlance", href: "/chat", icon: "spark" },
];

export const customerMobileNavigation = ["home", "pay", "parlance", "invest"].map((id) => customerDesktopNavigation.find((item) => item.id === id)!).filter(Boolean);
