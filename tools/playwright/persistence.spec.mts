import {
  expect,
  sendTurn,
  test,
  threadRevision,
  transcriptTexts,
  turnPosts,
  turnState,
} from "./fixtures.mjs";

/**
 * What a turn leaves behind once the page is reloaded.
 *
 * The streamed transcript is what one browser happened to receive; the saved thread is what the
 * Supervisor committed. Reloading throws the first away, so the only way the owner's words and
 * the agent's reply can still be on screen is that the page sent the prompt, the stub stored the
 * turn, and the page rendered the stored conversation it read back.
 */

const PROMPT = "Rename the sidebar heading to Projects (persistence check)";

test.describe("a saved turn", () => {
  test("keeps the exact prompt and the reply after a reload", async ({ owner, server }) => {
    await sendTurn(owner, PROMPT);
    await expect(turnState(owner)).toHaveText(/^saved · revision 4 · \d+ messages$/u);

    await owner.reload();
    await expect(threadRevision(owner)).toHaveText("4");
    await expect(transcriptTexts(owner, "user").last()).toHaveText(PROMPT);
    await expect(transcriptTexts(owner, "assistant").last()).toHaveText(
      "Verification passed, and EARLIER-EDIT-KEPT is still in the workspace.",
    );
    expect(turnPosts(server).map((request) => request.body)).toEqual([{ prompt: PROMPT }]);
  });
});

test.describe("a failed turn the Supervisor saved", () => {
  test.use({ scenario: "turn-failed" });

  test("keeps the prompt at the revision it reported", async ({ owner }) => {
    await sendTurn(owner, PROMPT);
    await expect(turnState(owner)).toHaveText("failed: model-error · saved at revision 4");

    await owner.reload();
    await expect(threadRevision(owner)).toHaveText("4");
    await expect(transcriptTexts(owner, "user").last()).toHaveText(PROMPT);
    await expect(transcriptTexts(owner, "assistant").last()).toHaveText(
      "Verification passed, and EARLIER-EDIT-KEPT is still in the workspace.",
    );
  });
});
