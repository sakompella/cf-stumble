import { OWNER_PAGE_IDS as ID } from "../../../src/page/element-ids.js";
import {
  assertIncludes,
  assertSame,
  BUILD_FAILED_COMMIT,
  BUILD_FAILED_STDERR,
  byId,
  readGeneration,
  readText,
  type HarnessCase,
} from "../harness.mjs";
import { openControls, submitCommit } from "./_generation.mjs";

export const CASES: readonly HarnessCase[] = [
  {
    id: "GEN-10",
    title: "a failed build step shows its output as collapsed escaped text",
    rank: "should",
    scenario: "ready",
    run: async ({ page }) => {
      await openControls(page);
      await submitCommit(page, BUILD_FAILED_COMMIT);
      const snapshot = await readGeneration(page);
      assertSame(
        snapshot.submitPreparation,
        "rejected: build-step-failed",
        "the build failure result",
      );

      const closed = await page.evaluate<boolean>(
        `document.getElementById(${JSON.stringify(ID.submitDiagnostics)}).open`,
      );

      assertSame(closed, false, "the build output panel before it is opened");

      await page.evaluate(
        `document.querySelector(${JSON.stringify(`${byId(ID.submitDiagnostics)} summary`)}).focus()`,
      );
      await page.press("Enter");

      const opened = await page.evaluate<boolean>(
        `document.getElementById(${JSON.stringify(ID.submitDiagnostics)}).open`,
      );

      assertSame(opened, true, "the build output panel after Enter on its summary");

      const shown = await readText(page, ID.submitDiagnosticsText);
      assertIncludes(shown, BUILD_FAILED_STDERR, "the stderr tail, character for character");
      assertIncludes(shown, "compiling 12 files", "the stdout tail");
      assertIncludes(shown, "truncated", "the truncation note");
      assertSame(
        shown.indexOf(BUILD_FAILED_STDERR) < shown.indexOf("compiling 12 files"),
        true,
        "stderr comes before stdout",
      );

      const injected = await page.evaluate<number>(
        `document.getElementById(${JSON.stringify(ID.submitDiagnosticsText)}).querySelectorAll("*").length`,
      );

      assertSame(injected, 0, "elements created from the command output");

      return `build output stayed collapsed, opened with Enter, showed ${shown.length} characters of escaped text with stderr first and a truncation note, and created no element`;
    },
  },
];
