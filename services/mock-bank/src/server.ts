import { buildApp } from "./app.js";
import { databaseCustomerSnapshot } from "./database-snapshot.js";

const customerSnapshot = process.env.PARLANCE_BANK_DATABASE_SNAPSHOT === "true" ? databaseCustomerSnapshot : undefined;
await buildApp(customerSnapshot ? { customerSnapshot } : {}).listen({ port: Number(process.env.PORT ?? 4002), host: "0.0.0.0" });
