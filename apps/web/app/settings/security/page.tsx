import { BankingShell } from "../../../components/banking/banking-shell";
import { PasskeySetupCard, PasskeyUnavailableCard } from "../../../components/security/passkey-setup-card";
import { connection } from "next/server";
import styles from "./security.module.css";

export default async function SecuritySettingsPage() {
  await connection();
  const publicSafeMode = process.env.PARLANCE_PUBLIC_SAFE_MODE === "true";
  const enrollmentEnabled = process.env.PARLANCE_PUBLIC_PASSKEY_ENROLLMENT_ENABLED === "true";
  return <BankingShell active="settings"><div className={styles.page}><header><p>Settings</p><h1>Security</h1><span>Manage how you verify sensitive banking actions.</span></header>{publicSafeMode && !enrollmentEnabled ? <PasskeyUnavailableCard /> : <PasskeySetupCard enrollmentOnly={publicSafeMode} />}</div></BankingShell>;
}
