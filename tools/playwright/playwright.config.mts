import { defineConfig } from "@playwright/test";
import { resolveChromePath } from "../browser-harness/chrome-binary.mjs";

/**
 * Behavioral browser tests for the owner page, run with `pnpm test:browser`.
 *
 * They drive the real page served by the browser harness stub, like `pnpm harness:browser`, but
 * through Playwright locators that name elements by role and label. The browser is the one the
 * harness already finds, so this suite downloads nothing; Playwright's own build is used only
 * when no other Chrome is present and `CF_STUMBLE_CHROME` is unset.
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
    launchOptions: { executablePath: await resolveChromePath() },
    viewport: { width: 1280, height: 900 },
    trace: "retain-on-failure",
  },
});
