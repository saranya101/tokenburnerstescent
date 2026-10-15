import "./globals.css";
import { connection } from "next/server";
import { WebAuthBoundary } from "../components/banking/web-auth-boundary";
export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  await connection();
  return <html lang="en" data-scroll-behavior="smooth"><body>{process.env.PARLANCE_PUBLIC_SAFE_MODE === "true" ? <WebAuthBoundary>{children}</WebAuthBoundary> : children}</body></html>;
}
