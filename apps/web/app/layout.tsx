import "./globals.css";
import { connection } from "next/server";
import { WebAuthBoundary } from "../components/banking/web-auth-boundary";
import { publicPasskeyExecutionEnabled } from "../lib/financial-capability";
export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  await connection();
  const safeMode = process.env.PARLANCE_PUBLIC_SAFE_MODE === "true";
  const webEnabled = process.env.PARLANCE_PUBLIC_WEB_ENABLED === "true";
  return <html lang="en" data-scroll-behavior="smooth"><body>{safeMode && webEnabled ? <WebAuthBoundary executionAvailable={publicPasskeyExecutionEnabled()}>{children}</WebAuthBoundary> : <>{safeMode && <div role="status" style={{ background: "#6b171b", color: "white", padding: "12px 20px", textAlign: "center", fontWeight: 700 }}>Interface preview only. Customer accounts and financial actions are unavailable until secure sign-in and the shared backend are ready.</div>}{children}</>}</body></html>;
}
