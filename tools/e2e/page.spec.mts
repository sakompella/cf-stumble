import { expect, test } from "@playwright/test";
import { OWNER_PAGE_IDS as ID } from "../../src/page/element-ids.js";
import { sendMessage, toolCalls, transcriptTexts, turnState } from "../playwright/fixtures.mjs";
import { Owner } from "./owner-api.mts";

const ANSWER_PROMPT = "Reply with the single word pineapple and nothing else.";

const CANCEL_PROMPT =
  "Use the bash tool to run exactly this command in the container: sleep 300. Then reply done.";

test("a turn streams, survives a reload, and a second turn can be cancelled", async ({ page }) => {
  const owner = new Owner(process.env["E2E_URL"] ?? "", process.env["E2E_OWNER_PASSWORD"] ?? "");
  const pageErrors: string[] = [];

  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto("/");
  await expect(page.locator(`#${ID.conversationState}`)).toHaveText("live");

  const answersBefore = await transcriptTexts(page, "assistant").count();

  await sendMessage(page, ANSWER_PROMPT);
  await expect(transcriptTexts(page, "user").last()).toHaveText(ANSWER_PROMPT);
  await expect(turnState(page)).toHaveText("answered");
  await expect(transcriptTexts(page, "assistant")).toHaveCount(answersBefore + 1);

  const answer = await transcriptTexts(page, "assistant").last().innerText();

  expect(answer.trim()).not.toBe("");

  await page.reload();
  await expect(page.locator(`#${ID.conversationState}`)).toHaveText("live");
  await expect(transcriptTexts(page, "user").last()).toHaveText(ANSWER_PROMPT);
  await expect(transcriptTexts(page, "assistant").last()).toHaveText(answer);

  await sendMessage(page, CANCEL_PROMPT);
  await expect(turnState(page)).toHaveText("running");
  await expect(toolCalls(page).last().locator("summary")).toContainText("sleep 300");
  await page.locator(`#${ID.cancelTurnButton}`).click();
  await expect(turnState(page)).toHaveText("stopped: aborted");

  await expect
    .poll(async () => (await owner.view("harness")).docs["pi.live"], { timeout: 15_000 })
    .toMatchObject({ runFailure: { reason: "aborted" } });
  expect((await owner.view("harness")).docs["pi.live"].run).toBeUndefined();

  await page.reload();
  await expect(transcriptTexts(page, "user").last()).toHaveText(CANCEL_PROMPT);
  expect(pageErrors).toEqual([]);
});
