import { ANSWER_TEXT, MODEL_ERROR, TOOL_OUTPUT } from "../browser-harness/conversations.mjs";
import {
  expect,
  messagePosts,
  sendMessage,
  test,
  toolCalls,
  transcriptTexts,
  turnState,
} from "./fixtures.mjs";

const PROMPT = "Rename the sidebar heading to Projects (persistence check)";

test("an answered run keeps the exact prompt and the reply after a reload", async ({
  owner,
  server,
}) => {
  await sendMessage(owner, PROMPT);
  await expect(turnState(owner)).toHaveText("answered");

  await owner.reload();

  await expect(transcriptTexts(owner, "user").last()).toHaveText(PROMPT);
  await expect(transcriptTexts(owner, "assistant").last()).toHaveText(ANSWER_TEXT);
  expect(messagePosts(server).map((request) => request.body)).toMatchObject([{ content: PROMPT }]);
});

test.describe("a run that is still going", () => {
  test.use({ scenario: "ready-paused" });

  test("outlives a reload and is still shown running, then answers", async ({ owner, server }) => {
    await sendMessage(owner, PROMPT);
    await server.waitForBarrier();

    await owner.reload();

    await expect(turnState(owner)).toHaveText("running");
    await expect(transcriptTexts(owner, "user").last()).toHaveText(PROMPT);
    await expect(toolCalls(owner).last().locator(".tool-output")).toHaveText(TOOL_OUTPUT[0]);

    server.release();

    await expect(turnState(owner)).toHaveText("answered");
    await expect(transcriptTexts(owner, "assistant").last()).toHaveText(ANSWER_TEXT);
  });
});

test.describe("a run whose model fails", () => {
  test.use({ scenario: "model-error" });

  test("says so, and still shows the prompt and the failure after a reload", async ({ owner }) => {
    await sendMessage(owner, PROMPT);
    await expect(turnState(owner)).toHaveText("stopped: model_error");
    await expect(transcriptTexts(owner, "terminal").last()).toHaveText(`failed: ${MODEL_ERROR}`);

    await owner.reload();

    await expect(transcriptTexts(owner, "user").last()).toHaveText(PROMPT);
    await expect(transcriptTexts(owner, "terminal").last()).toHaveText(`failed: ${MODEL_ERROR}`);
  });
});
