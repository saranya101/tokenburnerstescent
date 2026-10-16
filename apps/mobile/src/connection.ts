export function connectionConfigured(value: { apiBaseUrl: string }): boolean {
  try {
    const api = new URL(value.apiBaseUrl);
    return api.protocol === "https:" && !api.username && !api.password && !api.search && !api.hash && api.pathname === "/";
  } catch { return false; }
}
