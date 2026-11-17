import { OWNER_PAGE_IDS as ID } from "../../src/page/element-ids.js";
import { HARNESS_THREAD_MARKER } from "../browser-harness/conversations.mjs";
import { expect, projectButton, requestsTo, test } from "./fixtures.mjs";

const RECORD_STATES = `
window.__conversationStates = [];
new MutationObserver(() => {
  const text = document.getElementById(${JSON.stringify(ID.conversationState)})?.textContent ?? "";
  const states = window.__conversationStates;
  if (states.at(-1) !== text) states.push(text);
}).observe(document, { subtree: true, childList: true, characterData: true });
`;

test.beforeEach(async ({ page }) => {
  await page.addInitScript({ content: RECORD_STATES });
});

test("the first page load opens the event stream once and never reports reconnecting", async ({
  page,
  server,
}) => {
  await page.goto(`${server.url}/`);
  await expect(page.locator(`#${ID.conversationState}`)).toHaveText("live");

  const states = await page.evaluate<string[]>("window.__conversationStates");

  expect(states.filter((state) => state.includes("reconnecting"))).toEqual([]);
  expect(requestsTo(server, "GET", "/api/projects/octocat-hello-world/events")).toHaveLength(1);
});

test("switching to the harness project goes live without reconnecting", async ({
  page,
  server,
}) => {
  await page.goto(`${server.url}/`);
  await expect(page.locator(`#${ID.conversationState}`)).toHaveText("live");
  await page.evaluate("window.__conversationStates = []");
  await projectButton(page, "harness").click();
  await expect(page.locator(`#${ID.messageList}`)).toContainText(HARNESS_THREAD_MARKER);
  await expect(page.locator(`#${ID.conversationState}`)).toHaveText("live");

  const states = await page.evaluate<string[]>("window.__conversationStates");

  expect(states.filter((state) => state.includes("reconnecting"))).toEqual([]);
  expect(requestsTo(server, "GET", "/api/projects/harness/events")).toHaveLength(1);
});
