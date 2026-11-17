import { expect, test as base, type Page } from "@playwright/test";
import { OWNER_PAGE_IDS as ID } from "../../src/page/element-ids.js";
import type { HarnessScenario } from "../browser-harness/fixtures.mjs";
import { startHarnessServer, type HarnessServer } from "../browser-harness/server.mjs";

type OwnerPageFixtures = {
  scenario: HarnessScenario;
  allowedConsoleErrors: readonly RegExp[];
  refusedStatuses: readonly number[];
  server: HarnessServer;
  owner: Page;
};

export const test = base.extend<OwnerPageFixtures>({
  scenario: ["ready", { option: true }],
  allowedConsoleErrors: [[], { option: true }],
  refusedStatuses: [[], { option: true }],
  server: async ({ scenario }, use) => {
    const server = await startHarnessServer(scenario);
    await use(server);
    await server.close();
  },
  owner: async ({ page, server, allowedConsoleErrors, refusedStatuses }, use) => {
    const consoleErrors: string[] = [];
    page.on("console", (message) => {
      const isRefusal = refusedStatuses.some((status) =>
        message.text().includes(`the server responded with a status of ${status} `),
      );

      const isAllowed = allowedConsoleErrors.some((allowed) => allowed.test(message.text()));

      if (message.type() === "error" && !isRefusal && !isAllowed) {
        consoleErrors.push(message.text());
      }
    });
    page.on("pageerror", (error) => {
      consoleErrors.push(error.message);
    });

    await page.goto(`${server.url}/`);
    await expect(page.locator(`#${ID.conversationState}`)).toHaveText("live");
    await use(page);

    expect(consoleErrors, "console errors the owner page reported").toEqual([]);
  },
});

export { expect };

export function turnState(page: Page) {
  return page.locator(`#${ID.turnState}`);
}

export function runActive(page: Page) {
  return page.locator(`#${ID.threadRunActive}`);
}

export function projectButton(page: Page, projectId: string) {
  return page.locator(`.project-button[data-project-id="${projectId}"]`);
}

export function transcriptTexts(page: Page, role: "user" | "assistant" | "terminal") {
  return page.locator(`#${ID.messageList} > li.${role} > .text`);
}

export function toolCalls(page: Page) {
  return page.locator(`#${ID.messageList} details.tool-call`);
}

export function requestsTo(server: HarnessServer, method: "GET" | "POST", path: string) {
  return server.requests().filter((request) => request.method === method && request.path === path);
}

export function messagePosts(server: HarnessServer) {
  return server
    .requests()
    .filter((request) => request.method === "POST" && request.path.endsWith("/messages"));
}

export async function sendMessage(page: Page, prompt: string): Promise<void> {
  await page.getByLabel("prompt").fill(prompt);
  await page.getByRole("button", { name: "Send turn" }).click();
}
