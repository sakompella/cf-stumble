import { OWNER_PAGE_IDS as ID } from "../../../src/page/element-ids.js";
import {
  assertIncludes,
  assertNonEmpty,
  assertSame,
  focusDocument,
  readFocus,
  readGeneration,
  waitForText,
  type HarnessCase,
} from "../harness.mjs";

export const CASES: readonly HarnessCase[] = [
  {
    id: "KEY-2",
    title: "keyboard opens and operates all generation controls",
    rank: "should",
    scenario: "ready",
    run: async ({ page }) => {
      await focusDocument(page);
      await page.press("Tab");
      await page.press("Tab");
      assertSame((await readFocus(page)).tag, "summary", "generation summary focus target");
      await page.press("Enter");
      assertSame((await readGeneration(page)).drawerOpen, true, "drawer after Enter");

      await page.press("Tab");
      assertSame((await readFocus(page)).id, ID.candidateCommitInput, "first drawer stop");
      await page.insertText("def456");
      await page.press("Tab");
      assertSame((await readFocus(page)).id, ID.submitCandidateButton, "submit stop");
      await page.press("Enter");
      await waitForText(page, ID.submitStatus, "ok");

      await page.press("Tab");
      assertSame((await readFocus(page)).id, ID.activateLabelInput, "activate label stop");
      await page.insertText("1");
      await page.press("Tab");
      assertSame((await readFocus(page)).id, ID.activateButton, "activate stop");
      await page.press("Enter");
      await waitForText(page, ID.activateStatus, "ok");

      await page.press("Tab");
      assertSame((await readFocus(page)).id, ID.rollbackLabelInput, "rollback label stop");
      await page.insertText("1");
      await page.press("Tab");
      assertSame((await readFocus(page)).id, ID.rollbackButton, "rollback stop");
      await page.press("Enter");
      await waitForText(page, ID.rollbackStatus, "ok");

      const results = await readGeneration(page);
      assertNonEmpty(results.submitStatus, "submission result");
      assertNonEmpty(results.activateStatus, "activation result");
      assertNonEmpty(results.rollbackStatus, "rollback result");
      for (let count = 0; count < 6; count += 1) {
        await page.press("Tab", ["Shift"]);
      }
      assertSame((await readFocus(page)).tag, "summary", "focus returned to generation summary");
      await page.press("Space");
      assertSame((await readGeneration(page)).drawerOpen, false, "drawer after Space");
      await page.press("Tab");
      assertSame((await readFocus(page)).id, ID.sidebarToggle, "next stop after closed drawer");
      assertIncludes((await readFocus(page)).text, "Hide", "closed-drawer next focus");
      return "six generation controls were reached and operated by keyboard, then Space closed the drawer";
    },
  },
];
