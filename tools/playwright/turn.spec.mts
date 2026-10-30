import { OWNER_PAGE_IDS as ID } from "../../src/page/element-ids.js";
import { expect, sendTurn, test, threadRevision, transcriptTexts, turnState } from "./fixtures.mjs";

const PROMPT = "Rename the sidebar heading to Projects";

test.describe("a turn that is still running", () => {
  test.use({ scenario: "ready-paused" });

  test("shows its text and a finished tool before the stream closes", async ({ owner, server }) => {
    await sendTurn(owner, PROMPT);
    await server.waitForBarrier();

    await expect(turnState(owner)).toHaveText("running");
    await expect(transcriptTexts(owner, "assistant").first()).not.toBeEmpty();
    await expect(owner.locator("details.tool-call")).toHaveCount(1);
    await expect(owner.locator(`#${ID.sendTurnButton}`)).toBeDisabled();
    await expect(owner.locator(`#${ID.cancelTurnButton}`)).toBeEnabled();

    server.release();

    await expect(turnState(owner)).toHaveText(/^saved · revision 4/u);
    await expect(owner.locator("details.tool-call")).toHaveCount(3);
  });

  test("cancel closes the response and ignores the frames released afterwards", async ({
    owner,
    server,
  }) => {
    await sendTurn(owner, PROMPT);
    await server.waitForBarrier();
    await owner.locator(`#${ID.cancelTurnButton}`).click();
    await server.waitForResponseClosed();
    await expect(turnState(owner)).toHaveText("cancelled: this browser stopped the turn");

    const toolsAtCancel = await owner.locator("details.tool-call").count();
    server.release();
    await owner.waitForTimeout(300);

    await expect(owner.locator("details.tool-call")).toHaveCount(toolsAtCancel);
    await expect(turnState(owner)).toHaveText("cancelled: this browser stopped the turn");
    await expect(owner.locator(`#${ID.sendTurnButton}`)).toBeEnabled();
    await expect(threadRevision(owner)).toHaveText("3");
    expect(server.thread("octocat-hello-world").revision).toBe(3);
  });
});
