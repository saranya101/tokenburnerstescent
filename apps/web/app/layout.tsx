import "./globals.css";
import Link from "next/link";
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="en"><body><div className="shell"><header><h1>Parlance</h1><p>Trusted execution for agentic banking</p><nav className="flex gap-4"><Link href="/chat">Chat</Link><Link href="/opportunities">Opportunities</Link><Link href="/ops">Ops</Link></nav></header><main className="mt-8">{children}</main></div></body></html>; }
