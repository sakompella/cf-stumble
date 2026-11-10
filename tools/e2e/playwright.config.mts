import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "@playwright/test";

const chromiumPath = process.env["CHROMIUM_PATH"];

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.mts",
  forbidOnly: true,
  workers: 1,
  retries: 0,
  timeout: 6 * 60_000,
  expect: { timeout: 90_000 },
  reporter: "list",
  outputDir: join(tmpdir(), `cf-stumble-e2e-results-${process.env["E2E_RUN_ID"] ?? "local"}`),
  use: {
    browserName: "chromium",
    launchOptions: chromiumPath === undefined ? {} : { executablePath: chromiumPath },
    baseURL: process.env["E2E_URL"],
    httpCredentials: { username: "aditya", password: process.env["E2E_OWNER_PASSWORD"] ?? "" },
    viewport: { width: 1280, height: 900 },
    trace: "retain-on-failure",
  },
});
