import { defineConfig } from "@playwright/test";

/**
 * Behavioral browser tests for the owner page, run with `pnpm test:browser`.
 *
 * They drive the real page served by a local stub of the owner API. Playwright uses its own
 * Chromium unless `CHROMIUM_PATH` names another executable, which NixOS needs.
 */
export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.mts",
  fullyParallel: true,
  forbidOnly: true,
  timeout: 30_000,
  reporter: "list",
  use: {
    browserName: "chromium",
    launchOptions: { executablePath: process.env["CHROMIUM_PATH"] },
    viewport: { width: 1280, height: 900 },
    trace: "retain-on-failure",
  },
});
