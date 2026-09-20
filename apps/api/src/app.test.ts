import { expect, it } from "vitest";
import { buildApp } from "./app.js";
it("exposes health and trace ID", async () => { const response = await buildApp().inject({ method: "GET", url: "/health" }); expect(response.statusCode).toBe(200); expect(response.headers["x-trace-id"]).toBeTruthy(); });
