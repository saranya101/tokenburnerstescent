import Link from "next/link";
import type { ReactNode } from "react";
import { Icon } from "../ui/icon";
import { customerDesktopNavigation, customerMobileNavigation, type BankingSection } from "./banking-nav";

export function BankingShell({ active, children }: { active: BankingSection; children: ReactNode }) {
  return <div className="banking-shell">
    <header className="banking-header">
      <Link className="bank-brand" href="/" aria-label="DBS digibank prototype home"><span className="bank-wordmark"><b>DBS</b><span>digibank</span></span><span className="concept-label">Hackathon concept</span></Link>
      <div className="header-actions">
        <button type="button" className="icon-button search-button" aria-label="Search"><Icon name="search" /></button>
        <button type="button" className="icon-button" aria-label="Help"><Icon name="help" /></button>
        <button type="button" className="icon-button notification-button" aria-label="Notifications"><Icon name="bell" /><span /></button>
        <button type="button" className="profile-button" aria-label="Customer profile"><span>AT</span><b>Alex Tan</b><i>⌄</i></button>
      </div>
    </header>

    <aside className="banking-sidebar" aria-label="Banking navigation">
      <nav>{customerDesktopNavigation.map((item) => <Link key={item.id} href={item.href} className={`${active === item.id ? "is-active" : ""} ${item.id === "parlance" ? "is-parlance" : ""}`}><Icon name={item.icon} />{item.label}{item.id === "parlance" && <small>NEW</small>}</Link>)}</nav>
      <nav className="sidebar-secondary" aria-label="Support"><a href="#settings"><Icon name="settings" />Settings</a><a href="#help"><Icon name="help" />Help & support</a></nav>
    </aside>

    <main className="banking-content">{children}</main>

    <nav className="mobile-nav" aria-label="Mobile banking navigation">
      {customerMobileNavigation.map((item) => <Link key={item.id} href={item.href} className={active === item.id ? "is-active" : ""}><Icon name={item.icon} /><small>{item.label}</small></Link>)}
      <button type="button"><Icon name="more" /><small>More</small></button>
    </nav>
  </div>;
}
