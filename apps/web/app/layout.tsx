import "./globals.css";
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en" data-scroll-behavior="smooth"><body><div role="status" style={{ background: "#6b171b", color: "white", padding: "12px 20px", textAlign: "center", fontWeight: 700 }}>Interface preview only. Customer accounts and financial actions are unavailable until secure sign-in and the shared backend are ready.</div>{children}</body></html>;
}
