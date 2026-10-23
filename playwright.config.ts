import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/browser",
  testMatch: "*.e2e.ts",
  fullyParallel: false,
  workers: 1,
  // Multi-step journeys take longer on the shared VPS; keep action/assertion budgets.
  timeout: process.env.CI ? 60_000 : 30_000,
  use: {
    baseURL: "http://127.0.0.1:3107",
    headless: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "bun tests/browser/server.ts",
    url: "http://127.0.0.1:3107/healthz",
    reuseExistingServer: false,
  },
  reporter: "list",
});
