import { DemoControl } from "../../components/demo/demo-control";
import { cookies } from "next/headers";
import { configuredDemoUserId, demoModeEnabled, OPERATOR_SESSION_COOKIE, operatorSessionValid } from "../../lib/server-api-auth";

export default async function DemoPage() {
  const userId = configuredDemoUserId();
  if (!demoModeEnabled() || !userId || !operatorSessionValid((await cookies()).get(OPERATOR_SESSION_COOKIE)?.value)) {
    return <main><h1>Demo controls unavailable</h1><p>Operator login and coherent demo configuration are required.</p></main>;
  }
  return <DemoControl userId={userId} />;
}
