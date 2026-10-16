import { buildApp } from "./app.js";
import { databaseCustomerSnapshot } from "./database-snapshot.js";
import { durableBankEnabled, PrismaDurableBank } from "./durable-bank.js";

const durableBank = durableBankEnabled() ? new PrismaDurableBank() : undefined;
const customerSnapshot = !durableBank && process.env.PARLANCE_BANK_DATABASE_SNAPSHOT === "true" ? databaseCustomerSnapshot : undefined;
if (process.env.NODE_ENV === "production" && !durableBank && !customerSnapshot) {
  throw new Error("PRODUCTION_BANK_REQUIRES_DURABLE_OR_DATABASE_SNAPSHOT_MODE");
}
await buildApp(durableBank ? { durableBank } : customerSnapshot ? { customerSnapshot } : {}).listen({ port: Number(process.env.PORT ?? 4002), host: "0.0.0.0" });
