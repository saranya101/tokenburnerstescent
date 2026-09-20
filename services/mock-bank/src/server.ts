import { buildApp } from "./app.js";
await buildApp().listen({ port: Number(process.env.PORT ?? 4002), host: "0.0.0.0" });
