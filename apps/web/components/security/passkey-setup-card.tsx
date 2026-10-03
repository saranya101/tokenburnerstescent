"use client";

import { useEffect, useRef } from "react";
import { usePasskeyOnboarding } from "../../hooks/use-passkey-onboarding";
import { Icon } from "../ui/icon";
import styles from "./passkey-setup-card.module.css";

const copy = {
  LOADING: ["Checking passkey status…", "Your security settings are being loaded."],
  NOT_ENROLLED: ["No passkey set up", "Set up a passkey to authorize transactions. User verification is required."],
  ENROLLING: ["Setting up your passkey…", "Follow the instructions from your browser or device."],
  READY: ["Passkey ready", "Your passkey can authorize an exact transaction plan after you review it."],
  CANCELLED: ["Passkey setup was cancelled", "Nothing was authorized. You can try again when ready."],
  EXPIRED: ["Passkey setup timed out", "The registration challenge expired safely. Start again to receive a new challenge."],
  UNAVAILABLE: ["Passkeys are unavailable here", "Use a supported browser and device, then try again."],
  FAILED: ["Passkey setup could not be verified", "No transaction was authorized. Try again when ready."],
} as const;

export function PasskeySetupCard({ transaction, onReady }: { transaction?: boolean; onReady?(): void }) {
  const { state, enroll, reload } = usePasskeyOnboarding(); const prior = useRef(state.phase);
  useEffect(() => { if (state.phase === "READY" && prior.current === "ENROLLING") onReady?.(); prior.current = state.phase; }, [onReady, state.phase]);
  const [title, detail] = copy[state.phase]; const canEnroll = ["NOT_ENROLLED", "CANCELLED", "EXPIRED", "UNAVAILABLE", "FAILED"].includes(state.phase);
  return <section className={`product-card ${styles.card}`} aria-live="polite">
    <div className={styles.icon}><Icon name="shield" /></div>
    <div className={styles.content}>
      <p className="eyebrow">Security / Passkeys</p><h2>{transaction && state.phase === "NOT_ENROLLED" ? "Set up a passkey to authorize transactions" : title}</h2><p className="card-description">{detail}</p>
      <div className={styles.requirement}><Icon name="check" /><span>User verification required</span></div>
      <div className="card-actions">
        {canEnroll && <button className="button bank-primary" type="button" onClick={() => void enroll()}>{state.phase === "NOT_ENROLLED" ? "Set up passkey" : "Try again"}</button>}
        {state.phase === "FAILED" && <button className="button secondary" type="button" onClick={() => void reload()}>Check status</button>}
        {state.phase === "READY" && transaction && <button className="button bank-primary" type="button" onClick={onReady}>Return to plan</button>}
      </div>
    </div>
  </section>;
}
