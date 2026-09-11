import { OWNER_PAGE_IDS as ID } from "../../../src/page/element-ids.js";
import {
  assert,
  assertIncludes,
  assertSame,
  HARNESS_SELF_PROJECT_ID,
  focusDocument,
  readFocus,
  readLayout,
  readThread,
  tabUntil,
  waitForText,
  waitForThreadOk,
  readTranscript,
  HARNESS_THREAD_MARKER,
  type BrowserPage,
  type HarnessCase,
} from "../harness.mjs";

async function collapseAndRestore(page: BrowserPage): Promise<void> {
  await page.press("Enter");
  const hidden = await readLayout(page);
  assertSame(hidden.toggleLabel, "Show projects", "restore toggle label");
  assertSame(hidden.toggleExpanded, "false", "collapsed sidebar aria state");
  assert(hidden.sidebarWidth === 0, `collapsed sidebar still has width ${hidden.sidebarWidth}`);
  const restore = await page.box(`#${ID.sidebarToggle}`);
  assert(
    restore !== undefined && restore.width > 0 && restore.height > 0,
    "Show projects is not visibly reachable",
  );
  await page.press("Enter");
  const restored = await readLayout(page);
  assert(restored.sidebarWidth > 0, "restored sidebar has no visible box");
  assertSame(restored.toggleLabel, "Hide", "restored toggle label");
}

export const CASES: readonly HarnessCase[] = [
  {
    id: "KEY-4",
    title: "project, sidebar, and fresh thread work with keys only",
    rank: "should",
    scenario: "ready",
    run: async ({ page }) => {
      await focusDocument(page);
      await tabUntil(page, (stop) => stop.projectId === HARNESS_SELF_PROJECT_ID);
      const selected = await readFocus(page);
      assertSame(
        selected.projectId,
        HARNESS_SELF_PROJECT_ID,
        "harness project focus before selection",
      );
      await page.press("Enter");
      await waitForThreadOk(page);
      assertSame((await readThread(page)).project, "harness", "selected project after Enter");
      assertIncludes(
        (await readTranscript(page)).map((entry) => entry.text).join("\n"),
        HARNESS_THREAD_MARKER,
        "harness thread after selection",
      );
      assertSame(
        (await readFocus(page)).projectId,
        HARNESS_SELF_PROJECT_ID,
        "focus after project selection",
      );

      await page.press("Tab", ["Shift"]);
      await page.press("Tab", ["Shift"]);
      assertSame((await readFocus(page)).id, ID.sidebarToggle, "Hide focus after Shift-Tab");
      await collapseAndRestore(page);
      await tabUntil(page, (stop) => stop.id === ID.freshThreadButton);
      await page.press("Enter");
      await waitForText(page, ID.freshThreadStatus, "click again");
      const armed = await readThread(page);
      assertSame(armed.messageCount, "2", "thread before fresh confirmation");
      await page.press("Enter");
      await waitForText(page, ID.freshThreadStatus, "fresh thread started");
      const fresh = await readThread(page);
      assertSame(fresh.messageCount, "0", "messages after confirmed fresh thread");
      assertSame(fresh.revision, "4", "revision after confirmed fresh thread");

      return "harness selection, sidebar restore, and two-step fresh thread confirmation were driven with keyboard input";
    },
  },
];
