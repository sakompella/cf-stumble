import { OWNER_PAGE_IDS as ID } from "../../src/page/element-ids.js";
import { expect, test, turnState } from "./fixtures.mjs";

test("the fresh thread confirmation expires, and its button says it is waiting", async ({
  owner,
}) => {
  const fresh = owner.locator(`#${ID.freshThreadButton}`);
  const status = owner.locator(`#${ID.freshThreadStatus}`);

  await owner.clock.install();
  await expect(fresh).toHaveText("Start fresh thread");
  await fresh.click();

  await expect(fresh).toHaveText("Confirm fresh thread");
  await expect(status).toContainText("click again to replace this conversation");

  await owner.clock.runFor(11_000);

  await expect(fresh).toHaveText("Start fresh thread");
  await expect(status).toHaveText("");
});

test("a fresh thread started in one window is announced in the other", async ({
  owner,
  server,
}) => {
  const other = await owner.context().newPage();

  await other.goto(`${server.url}/`);
  await expect(other.locator(`#${ID.conversationState}`)).toHaveText("live");
  await expect(other.locator(`#${ID.messageList} > li`)).toHaveCount(2);

  await owner.locator(`#${ID.freshThreadButton}`).click();
  await owner.locator(`#${ID.freshThreadButton}`).click();

  await expect(other.locator(`#${ID.messageList} > li`)).toHaveCount(0);
  await expect(turnState(other)).toHaveText("this conversation was replaced by a fresh thread");
});
