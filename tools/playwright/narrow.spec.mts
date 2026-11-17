import { OWNER_PAGE_IDS as ID } from "../../src/page/element-ids.js";
import { expect, test } from "./fixtures.mjs";

test.use({ viewport: { width: 390, height: 720 } });

test("a phone puts the conversation above the sidebar without sideways scrolling", async ({
  owner,
}) => {
  const sidebar = await owner.locator(`#${ID.sidebar}`).boundingBox();
  const conversation = await owner.locator(`#${ID.conversation}`).boundingBox();

  expect(sidebar && conversation && conversation.y + conversation.height <= sidebar.y + 1).toBe(
    true,
  );
  await expect(owner.getByLabel("prompt")).toBeVisible();
  await expect(owner.locator(`#${ID.sendTurnButton}`)).toBeVisible();

  const overflow = await owner.evaluate<number>(
    "document.documentElement.scrollWidth - document.documentElement.clientWidth",
  );

  expect(overflow).toBeLessThanOrEqual(1);
});

test("the composer is on the first screen and every control is at least 44 px high", async ({
  owner,
}) => {
  const viewport = owner.viewportSize();
  const prompt = await owner.getByLabel("prompt").boundingBox();
  const send = await owner.locator(`#${ID.sendTurnButton}`).boundingBox();

  expect(prompt && viewport && prompt.y + prompt.height <= viewport.height).toBe(true);
  expect(send && viewport && send.y + send.height <= viewport.height).toBe(true);

  const controls = await owner.locator("button:visible, input:visible, summary:visible").all();
  const short: string[] = [];

  for (const control of controls) {
    const box = await control.boundingBox();

    if (box !== null && box.height < 44) short.push(`${await control.innerText()} (${box.height})`);
  }

  expect(controls.length).toBeGreaterThan(10);
  expect(short).toEqual([]);
});
