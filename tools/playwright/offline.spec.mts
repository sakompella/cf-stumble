import { OWNER_PAGE_IDS as ID } from "../../src/page/element-ids.js";
import { ANSWER_TEXT } from "../browser-harness/conversations.mjs";
import {
  expect,
  messagePosts,
  sendMessage,
  test,
  transcriptTexts,
  turnState,
} from "./fixtures.mjs";

const PROMPT = "Rename the sidebar heading to Projects";

const FOLLOW_UP = "Then run the tests again";

test.describe("a browser that goes offline during a run", () => {
  test.use({ scenario: "ready-paused", allowedConsoleErrors: [/net::ERR_INTERNET_DISCONNECTED/u] });

  test("says it is offline, then sends the unconfirmed message again once", async ({
    owner,
    server,
  }) => {
    await sendMessage(owner, PROMPT);
    await server.waitForBarrier();
    await owner.context().setOffline(true);

    await expect(owner.locator(`#${ID.conversationState}`)).toHaveText("offline");

    await sendMessage(owner, FOLLOW_UP);

    await expect(owner.locator(`#${ID.messageList} > li.user`).last().locator(".who")).toHaveText(
      "you · not confirmed",
    );
    await expect(turnState(owner)).toHaveText(/^running · not confirmed/u);

    await owner.context().setOffline(false);

    await expect(owner.locator(`#${ID.conversationState}`)).toHaveText("live");
    await expect(owner.locator(`#${ID.messageList} > li.user`).last().locator(".who")).toHaveText(
      "you · queued",
    );

    server.release();

    await expect(turnState(owner)).toHaveText("answered");
    await expect(transcriptTexts(owner, "user")).toHaveText([
      /^Read the README/u,
      PROMPT,
      FOLLOW_UP,
    ]);
    await expect(transcriptTexts(owner, "assistant").last()).toHaveText(ANSWER_TEXT);
    expect(messagePosts(server).map((request) => request.body)).toMatchObject([
      { content: PROMPT },
      { content: FOLLOW_UP },
    ]);
  });
});
