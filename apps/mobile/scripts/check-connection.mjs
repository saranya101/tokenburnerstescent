// Read-only preflight: no credentials or banking writes.
try {
  const api = new URL(process.env.PARLANCE_MOBILE_PUBLIC_API_URL ?? "");
  if (api.protocol !== "https:" || api.username || api.password || api.pathname !== "/" || api.search || api.hash) throw new Error("Configure an HTTPS API origin");
  const response = await fetch(`${api.origin}/api/mobile/customer/state`, { redirect: "manual", signal: AbortSignal.timeout(10000) });
  if (response.status !== 401) throw new Error(`Anonymous customer state returned ${response.status}; expected 401`);
  console.log("PASS: HTTPS API and anonymous authorization boundary. Sign in or sign up directly with email and password; no Auth0 configuration is required.");
} catch (error) { console.error(error instanceof Error ? error.message : "Connection check failed"); process.exitCode = 1; }
