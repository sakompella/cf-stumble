import { OWNER_PAGE_IDS as ID } from "../../src/page/element-ids.js";
import { expect, test } from "./fixtures.mjs";

test.use({ viewport: { width: 390, height: 720 } });

test("a phone stacks the sidebar above the conversation without sideways scrolling", async ({
  owner,
}) => {
  const sidebar = await owner.locator(`#${ID.sidebar}`).boundingBox();
  const conversation = await owner.locator(`#${ID.conversation}`).boundingBox();

  expect(sidebar && conversation && sidebar.y + sidebar.height <= conversation.y + 1).toBe(true);
  await expect(owner.getByLabel("prompt")).toBeVisible();
  await expect(owner.locator(`#${ID.sendTurnButton}`)).toBeVisible();

  const overflow = await owner.evaluate<number>(
    "document.documentElement.scrollWidth - document.documentElement.clientWidth",
  );

  expect(overflow).toBeLessThanOrEqual(1);
});
