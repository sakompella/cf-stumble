import { OWNER_PAGE_IDS as ID } from "../../../src/page/element-ids.js";
import { assertSame, byId, readBox, readGeneration, type HarnessCase } from "../harness.mjs";
import { openControls } from "./_generation.mjs";

export const CASES: readonly HarnessCase[] = [
  {
    id: "GEN-1",
    title: "active generation stays visible while controls are closed",
    rank: "must",
    scenario: "ready",
    run: async ({ page }) => {
      const before = await readGeneration(page);
      const hiddenSubmit = await readBox(page, byId(ID.submitCandidateButton));
      assertSame(before.activeLabel, "1", "the active generation label");
      assertSame(before.activeCommit, "abc123", "the active generation commit");
      assertSame(before.activeStatus, "ready", "the active generation status");
      assertSame(before.epoch, "3", "the displayed generation epoch");
      assertSame(before.lastRead, "ok", "the initial status read");
      assertSame(before.drawerOpen, false, "the initially closed generation drawer");
      assertSame(hiddenSubmit.visible, false, "Submit visibility while controls are closed");

      await openControls(page);
      const open = await readGeneration(page);
      const visibleSubmit = await readBox(page, byId(ID.submitCandidateButton));
      assertSame(open.drawerOpen, true, "the open generation drawer");
      assertSame(open.activeLabel, before.activeLabel, "the active label after opening controls");
      assertSame(visibleSubmit.visible, true, "Submit visibility while controls are open");
      await page.click(byId(ID.submitCandidateButton));
      await page.waitFor(
        `document.getElementById(${JSON.stringify(ID.submitStatus)})?.textContent !== ""`,
      );

      return `generation 1 abc123 ready at epoch 3 stayed visible; Submit changed from hidden to a ${visibleSubmit.width}×${visibleSubmit.height}px box when the drawer opened`;
    },
  },
];
