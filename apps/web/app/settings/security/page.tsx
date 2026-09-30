import { BankingShell } from "../../../components/banking/banking-shell";
import { PasskeySetupCard } from "../../../components/security/passkey-setup-card";
import styles from "./security.module.css";

export default function SecuritySettingsPage() {
  return <BankingShell active="settings"><div className={styles.page}><header><p>Settings</p><h1>Security</h1><span>Manage how you verify sensitive banking actions.</span></header><PasskeySetupCard /></div></BankingShell>;
}
