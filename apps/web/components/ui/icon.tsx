import type { SVGProps } from "react";

export type IconName = "home" | "accounts" | "transfer" | "card" | "invest" | "spark" | "search" | "help" | "bell" | "mic" | "send" | "check" | "warning" | "wallet" | "fx" | "asset" | "recipient" | "more" | "eye" | "settings" | "arrow" | "shield";

const paths: Record<IconName, React.ReactNode> = {
  home: <><path d="m3 10 9-7 9 7"/><path d="M5 9v11h14V9M9 20v-6h6v6"/></>,
  accounts: <><rect x="3" y="5" width="18" height="15" rx="2"/><path d="M3 9h18M7 15h3"/></>,
  transfer: <><path d="M4 7h15m0 0-4-4m4 4-4 4M20 17H5m0 0 4-4m-4 4 4 4"/></>,
  card: <><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18M7 15h4"/></>,
  invest: <><path d="M4 19V9m6 10V5m6 14v-7m4 7H2"/><path d="m4 7 6-4 6 6 5-5"/></>,
  spark: <><path d="m12 2 1.8 6.2L20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8L12 2Z"/><path d="m19 16 .7 2.3L22 19l-2.3.7L19 22l-.7-2.3L16 19l2.3-.7L19 16Z"/></>,
  search: <><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></>,
  help: <><circle cx="12" cy="12" r="9"/><path d="M9.8 9a2.3 2.3 0 1 1 3.5 2c-.8.5-1.3 1-1.3 2M12 17h.01"/></>,
  bell: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/></>,
  mic: <><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6"/></>,
  send: <><path d="m4 12 16-8-5 16-3-6-8-2Z"/><path d="m12 14 8-10"/></>,
  check: <path d="m5 12 4 4L19 6"/>,
  warning: <><path d="M12 3 2.8 20h18.4L12 3Z"/><path d="M12 9v4m0 3h.01"/></>,
  wallet: <><path d="M4 6h14a2 2 0 0 1 2 2v11H4a2 2 0 0 1-2-2V6a3 3 0 0 1 3-3h12"/><path d="M15 12h5v4h-5a2 2 0 0 1 0-4Z"/></>,
  fx: <><path d="M7 7h12m0 0-3-3m3 3-3 3M17 17H5m0 0 3-3m-3 3 3 3"/></>,
  asset: <><path d="M4 19h16M6 16l4-5 3 3 5-8"/><circle cx="18" cy="6" r="2"/></>,
  recipient: <><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></>,
  more: <><circle cx="5" cy="12" r="1" fill="currentColor"/><circle cx="12" cy="12" r="1" fill="currentColor"/><circle cx="19" cy="12" r="1" fill="currentColor"/></>,
  eye: <><path d="M2 12s4-6 10-6 10 6 10 6-4 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="2.5"/></>,
  settings: <><circle cx="12" cy="12" r="3"/><path d="M19 13.5v-3l-2-.7a7 7 0 0 0-.7-1.6l1-1.9-2.1-2.1-1.9 1a7 7 0 0 0-1.6-.7L11 2H8l-.7 2.5a7 7 0 0 0-1.6.7l-1.9-1-2.1 2.1 1 1.9a7 7 0 0 0-.7 1.6l-2 .7v3l2 .7a7 7 0 0 0 .7 1.6l-1 1.9 2.1 2.1 1.9-1a7 7 0 0 0 1.6.7L8 22h3l.7-2.5a7 7 0 0 0 1.6-.7l1.9 1 2.1-2.1-1-1.9a7 7 0 0 0 .7-1.6l2-.7Z" transform="translate(2) scale(.83)"/></>,
  arrow: <><path d="M5 12h14M14 7l5 5-5 5"/></>,
  shield: <><path d="M12 3 5 6v5c0 4.6 2.8 8 7 10 4.2-2 7-5.4 7-10V6l-7-3Z"/><path d="m9 12 2 2 4-4"/></>,
};

export function Icon({ name, ...props }: { name: IconName } & SVGProps<SVGSVGElement>) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>{paths[name]}</svg>;
}
