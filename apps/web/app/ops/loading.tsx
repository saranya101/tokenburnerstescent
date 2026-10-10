import styles from "./ops.module.css";

export default function OpsLoading() {
  return <div className={styles.appShell} aria-busy="true" aria-label="Loading operations portal">
    <header className={styles.topbar}><div className={styles.brand}><span className={styles.dbs}>DBS</span><span className={styles.brandDivider} /><span><strong>Parlance</strong><small>Operations Portal</small></span></div></header>
    <aside className={styles.sidebar} aria-hidden="true"><nav>{["Overview", "Executions", "Plan traces", "Approvals", "Audit trail"].map((label) => <button type="button" disabled key={label}><span>{label}</span></button>)}</nav></aside>
    <main className={styles.main}><section className={styles.loadingHeader}><i /><i /><i /></section><section className={styles.loadingMetrics}>{[0, 1, 2, 3].map((item) => <i key={item} />)}</section><section className={styles.loadingTable}><i />{[0, 1, 2, 3, 4].map((item) => <span key={item} />)}</section></main>
  </div>;
}
