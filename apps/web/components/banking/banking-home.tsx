import Link from "next/link";
import { Icon, type IconName } from "../ui/icon";
import { demoBankingData } from "./demo-banking-data";

const actionIcons: Array<{ label: string; icon: IconName }> = [{ label: "Pay", icon: "recipient" }, { label: "Transfer", icon: "transfer" }, { label: "Convert", icon: "fx" }, { label: "Invest", icon: "invest" }];

export function BankingHome() {
  return <div className="banking-home">
    <div className="home-heading"><div><p>Good afternoon, Alex</p><h1>Here’s your financial overview.</h1></div><span>Updated just now</span></div>

    <div className="dashboard-top-grid">
      <section className="balance-hero" aria-labelledby="total-balance-heading">
        <div className="balance-hero-top"><div><span>Total balance</span><h2 id="total-balance-heading">{demoBankingData.totalBalance}</h2><p><b>↗ 2.4%</b> from last month</p></div><button type="button" aria-label="Hide balances"><Icon name="eye" /> Hide</button></div>
        <svg className="balance-sparkline" viewBox="0 0 520 90" preserveAspectRatio="none" aria-label="Balance has increased over six months"><path d="M0 74C45 68 60 45 105 52s62 27 103 6 55-39 100-31 68 35 105 13 64-31 107-34" /><path className="sparkline-area" d="M0 74C45 68 60 45 105 52s62 27 103 6 55-39 100-31 68 35 105 13 64-31 107-34V90H0Z" /></svg>
        <div className="balance-period"><span>Apr</span><span>May</span><span>Jun</span><span>Jul</span><span>Aug</span><span>Sep</span></div>
      </section>

      <section className="parlance-feature" aria-labelledby="ask-parlance-heading">
        <div className="feature-orbit" aria-hidden="true"><i /><i /></div><span className="parlance-feature-icon"><Icon name="spark" /></span><p>Parlance</p><h2 id="ask-parlance-heading">Do more with one request.</h2><blockquote>“Send NTU US$5,000 and keep S$1,000 available.”</blockquote><Link className="button feature-button" href="/chat">Ask Parlance <Icon name="arrow" /></Link>
      </section>
    </div>

    <section className="dashboard-section" id="accounts"><div className="dashboard-section-heading"><div><h2>Your accounts</h2><p>Available balances across currencies</p></div><button type="button">View all <Icon name="arrow" /></button></div><div className="account-card-grid">{demoBankingData.accounts.map((account, index) => <article className="account-card" key={account.number}><span className={`account-card-icon tone-${index}`}><Icon name={index === 2 ? "fx" : "wallet"} /></span><div><small>{account.name}</small><strong>{account.currency === "SGD" ? "S$" : "US$"}{account.balance}</strong><span>{account.number} · Available</span></div><button type="button" aria-label={`Open ${account.name}`}><Icon name="arrow" /></button></article>)}</div></section>

    <div className="dashboard-main-grid">
      <section className="dashboard-surface cashflow-card"><div className="dashboard-section-heading"><div><h2>Monthly cashflow</h2><p>September 2026</p></div><button type="button">This month⌄</button></div><div className="cashflow-metrics"><p><span>Money in</span><strong className="is-positive">S$6,240</strong></p><p><span>Money out</span><strong>S$3,180</strong></p><p><span>Net cashflow</span><strong>S$3,060</strong></p></div><div className="cashflow-chart" role="img" aria-label="Weekly inflow and outflow bars"><div className="chart-scale"><span>6k</span><span>3k</span><span>0</span></div>{demoBankingData.cashflow.map((week) => <div className="chart-week" key={week.label}><div className="bar-pair"><i style={{ height: `${week.inflow}%` }} /><i style={{ height: `${week.outflow}%` }} /></div><span>{week.label}</span></div>)}</div><div className="chart-legend"><span><i className="inflow" />Money in</span><span><i className="outflow" />Money out</span></div></section>

      <section className="dashboard-surface quick-actions-card" id="actions"><div className="dashboard-section-heading"><div><h2>Quick actions</h2><p>What would you like to do?</p></div></div><div className="quick-actions">{actionIcons.map((action) => <button type="button" key={action.label}><span><Icon name={action.icon} /></span>{action.label}</button>)}</div><div className="investment-summary" id="investments"><span><Icon name="invest" /></span><div><small>Investments</small><strong>{demoBankingData.investmentValue}</strong><p>{demoBankingData.investmentChange}</p></div><button type="button"><Icon name="arrow" /></button></div></section>
    </div>

    <section className="dashboard-surface activity-panel"><div className="dashboard-section-heading"><div><h2>Recent activity</h2><p>Your latest transactions</p></div><button type="button">View all <Icon name="arrow" /></button></div><div className="activity-table"><div className="activity-table-head"><span>Transaction</span><span>Category</span><span>Status</span><span>Amount</span></div>{demoBankingData.activity.map((activity) => <article key={`${activity.merchant}-${activity.date}`}><span className={`activity-icon is-${activity.kind}`}>{activity.initials}</span><div><strong>{activity.merchant}</strong><small>{activity.date}</small></div><span className="activity-category">{activity.category}</span><span className="activity-status"><i />Completed</span><b className={activity.kind === "credit" ? "is-positive" : ""}>{activity.amount}</b></article>)}</div></section>
    <p className="demo-data-note">Hackathon prototype · Display-only banking demo data</p>
  </div>;
}
