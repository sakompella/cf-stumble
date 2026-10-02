import { OWNER_PAGE_IDS as ID } from "../../../src/page/element-ids.js";
import {
  assertIncludes,
  assertSame,
  BUILD_FAILED_COMMIT,
  BUILD_FAILED_STDERR,
  BROKEN_CANDIDATE_COMMIT,
  byId,
  readGeneration,
  readText,
  waitForText,
  type BrowserPage,
  type HarnessCase,
} from "../harness.mjs";
import { openControls, submitCommit } from "./_generation.mjs";

const ID_LITERAL = JSON.stringify(ID.submitDiagnostics);

const TEXT_LITERAL = JSON.stringify(ID.submitDiagnosticsText);

type PanelState = Readonly<{ hidden: boolean; open: boolean; text: string }>;

function readPanel(page: BrowserPage): Promise<PanelState> {
  return page.evaluate<PanelState>(`(() => {
    const box = document.getElementById(${ID_LITERAL});
    return {
      hidden: box.hidden,
      open: box.open,
      text: document.getElementById(${TEXT_LITERAL}).textContent,
    };
  })()`);
}

function assertCleared(panel: PanelState, when: string): void {
  assertSame(panel.hidden, true, `the build output panel hidden ${when}`);
  assertSame(panel.open, false, `the build output panel closed ${when}`);
  assertSame(panel.text, "", `the build output text ${when}`);
}

async function submitAndWait(
  page: BrowserPage,
  commit: string,
  preparation: string,
): Promise<void> {
  await page.type(byId(ID.candidateCommitInput), commit);
  await page.click(byId(ID.submitCandidateButton));
  await waitForText(page, ID.submitPreparation, preparation);
}

async function checkInFlightClearing(page: BrowserPage): Promise<void> {
  await page.evaluate(`(() => {
    const real = window.fetch;
    window.realFetch = real;
    window.releaseSubmit = null;
    window.fetch = (input, init) => {
      if (String(input).endsWith("/api/generations/submit")) {
    return new Promise((resolve) => {
      window.releaseSubmit = () => resolve(real(input, init));
    });
      }
      return real(input, init);
    };
  })()`);
  await page.type(byId(ID.candidateCommitInput), "def456");
  await page.click(byId(ID.submitCandidateButton));
  await waitForText(page, ID.submitStatus, "running");
  assertCleared(await readPanel(page), "while a submission is in flight");
  await page.evaluate("(() => { window.fetch = window.realFetch; window.releaseSubmit(); })()");
  await waitForText(page, ID.submitPreparation, "ready: startup check answered");
  assertCleared(await readPanel(page), "after a successful submission");
}

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

      await checkInFlightClearing(page);

      await submitAndWait(page, BUILD_FAILED_COMMIT, "rejected: build-step-failed");
      assertSame(
        (await readPanel(page)).hidden,
        false,
        "the build output panel after a second failure",
      );
      await submitAndWait(page, BROKEN_CANDIDATE_COMMIT, "rejected: startup-check-failed");
      assertCleared(await readPanel(page), "after a rejection without build output");

      return `build output stayed collapsed, opened with Enter, showed ${shown.length} characters of escaped text with stderr first and a truncation note, and created no element; it was cleared in flight, after a success, and after a rejection that carried none`;
    },
  },
];
