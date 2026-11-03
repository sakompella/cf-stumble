import { defineConfig } from "@playwright/test";
import { HARNESS_CREDENTIALS } from "../browser-harness/fixtures.mjs";

const chromiumPath = process.env["CHROMIUM_PATH"];

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.mts",
  fullyParallel: true,
  forbidOnly: true,
  timeout: 30_000,
  reporter: "list",
  use: {
    browserName: "chromium",
    launchOptions: chromiumPath === undefined ? {} : { executablePath: chromiumPath },
    httpCredentials: HARNESS_CREDENTIALS,
    viewport: { width: 1280, height: 900 },
    trace: "retain-on-failure",
  },
});
