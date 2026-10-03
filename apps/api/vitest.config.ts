import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The PostgreSQL integration files intentionally exercise concurrent transactions internally.
    // Keep files serial only when those live-database suites are enabled so their independent
    // connection pools do not contend for the dedicated test database at suite startup/cleanup.
    fileParallelism: process.env.TEST_DATABASE_URL === undefined,
  },
});
