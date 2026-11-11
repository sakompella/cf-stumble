import { OWNER_PAGE_IDS as ID } from "../../src/page/element-ids.js";
import {
  ANSWER_TEXT,
  OPENING_TEXT,
  TOOL_COMMAND,
  TOOL_OUTPUT,
} from "../browser-harness/conversations.mjs";
import { HARNESS_PROJECT_ID } from "../browser-harness/fixtures.mjs";
import {
  expect,
  messagePosts,
  requestsTo,
  runActive,
  sendMessage,
  test,
  toolCalls,
  transcriptTexts,
  turnState,
} from "./fixtures.mjs";

const PROMPT = "Rename the sidebar heading to Projects";

const FOLLOW_UP = "Then run the tests again";

const ABORT_PATH = `/api/projects/${HARNESS_PROJECT_ID}/abort`;

test.describe("a run that is still going", () => {
  test.use({ scenario: "ready-paused" });

  test("shows its text and the running tool's output before it answers", async ({
    owner,
    server,
  }) => {
    await sendMessage(owner, PROMPT);
    await server.waitForBarrier();

    await expect(turnState(owner)).toHaveText("running");
    await expect(runActive(owner)).toHaveText("yes");
    await expect(transcriptTexts(owner, "user").last()).toHaveText(PROMPT);
    await expect(transcriptTexts(owner, "assistant").last()).toHaveText(OPENING_TEXT);
    await expect(toolCalls(owner).last().locator("summary")).toHaveText(
      `bash {"command":"${TOOL_COMMAND}"}`,
    );
    await expect(toolCalls(owner).last().locator(".tool-output")).toHaveText(TOOL_OUTPUT[0]);
    await expect(owner.locator(`#${ID.sendTurnButton}`)).toBeEnabled();
    await expect(owner.locator(`#${ID.cancelTurnButton}`)).toBeEnabled();

    server.release();

    await expect(turnState(owner)).toHaveText("answered");
    await expect(transcriptTexts(owner, "assistant").last()).toHaveText(ANSWER_TEXT);
    await expect(toolCalls(owner).last().locator("summary")).toHaveText("bash — done");
    await expect(runActive(owner)).toHaveText("no");
    await expect(owner.locator(`#${ID.cancelTurnButton}`)).toBeDisabled();
  });

  test("cancel aborts the run, and nothing answers it afterwards", async ({ owner, server }) => {
    await sendMessage(owner, PROMPT);
    await server.waitForBarrier();
    await owner.locator(`#${ID.cancelTurnButton}`).click();

    await expect(turnState(owner)).toHaveText("stopped: aborted");
    expect(requestsTo(server, "POST", ABORT_PATH)).toHaveLength(1);

    server.release();
    await owner.waitForTimeout(300);

    await expect(turnState(owner)).toHaveText("stopped: aborted");
    await expect(transcriptTexts(owner, "assistant").last()).toHaveText(OPENING_TEXT);
    await expect(owner.locator(`#${ID.cancelTurnButton}`)).toBeDisabled();
    await expect(owner.locator(`#${ID.sendTurnButton}`)).toBeEnabled();
    expect(server.openEventStreams(HARNESS_PROJECT_ID)).toBe(1);
  });
});

test.describe("a follow-up", () => {
  test.use({ scenario: "ready-paused" });

  test("sent while a run is going waits as queued, then is answered after it", async ({
    owner,
    server,
  }) => {
    await sendMessage(owner, PROMPT);
    await server.waitForBarrier();
    await sendMessage(owner, FOLLOW_UP);

    const queued = owner.locator(`#${ID.messageList} > li.user`).last();

    await expect(queued.locator(".who")).toHaveText("you · queued");
    await expect(queued.locator(".text")).toHaveText(FOLLOW_UP);
    await expect(turnState(owner)).toHaveText("running · 1 queued");

    server.release();

    await expect(turnState(owner)).toHaveText("answered");
    await expect(transcriptTexts(owner, "user")).toHaveText([
      /^Read the README/u,
      PROMPT,
      FOLLOW_UP,
    ]);
    await expect(transcriptTexts(owner, "assistant").last()).toHaveText(ANSWER_TEXT);
    await expect(owner.locator(`#${ID.messageList} > li.user .who`)).toHaveText([
      "you",
      "you",
      "you",
    ]);

    const posts = messagePosts(server).map((request) => request.body);

    expect(posts).toMatchObject([{ content: PROMPT }, { content: FOLLOW_UP }]);
    expect(new Set(posts.map((body) => JSON.stringify(body))).size).toBe(2);
  });
});

test.describe("a follow-up queued before a cancel", () => {
  test.use({ scenario: "ready-paused" });

  test("is withdrawn when the run is cancelled, with no Queued row left", async ({
    owner,
    server,
  }) => {
    await sendMessage(owner, PROMPT);
    await server.waitForBarrier();
    await sendMessage(owner, FOLLOW_UP);
    await expect(turnState(owner)).toHaveText("running · 1 queued");
    await owner.locator(`#${ID.cancelTurnButton}`).click();

    await expect(turnState(owner)).toHaveText("stopped: aborted");
    await expect(transcriptTexts(owner, "user")).toHaveText([/^Read the README/u, PROMPT]);
    server.release();
    await owner.reload();

    await expect(transcriptTexts(owner, "user")).toHaveText([/^Read the README/u, PROMPT]);
    await expect(owner.locator(`#${ID.messageList}`)).not.toContainText("Queued");
  });
});

test("a fresh thread needs a second click, then shows an empty conversation", async ({
  owner,
  server,
}) => {
  const fresh = owner.locator(`#${ID.freshThreadButton}`);
  const status = owner.locator(`#${ID.freshThreadStatus}`);

  await fresh.click();
  await expect(status).toHaveText(
    "click again to replace this conversation; repository files are untouched",
  );
  expect(requestsTo(server, "POST", `/api/projects/${HARNESS_PROJECT_ID}/thread/fresh`)).toEqual(
    [],
  );

  await fresh.click();

  await expect(status).toHaveText("fresh thread started; repository files are untouched");
  await expect(owner.locator(`#${ID.conversationState}`)).toHaveText("live");
  await expect(owner.locator(`#${ID.messageList} > li`)).toHaveCount(0);
  expect(await server.entries(HARNESS_PROJECT_ID)).toEqual([]);
  await expect.poll(() => server.openEventStreams(HARNESS_PROJECT_ID)).toBe(1);

  await sendMessage(owner, PROMPT);

  await expect(turnState(owner)).toHaveText("answered");
  await expect(transcriptTexts(owner, "user")).toHaveText([PROMPT]);
});
