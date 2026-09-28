import { expect, test as base, type Page } from "@playwright/test";
import { OWNER_PAGE_IDS as ID } from "../../src/page/element-ids.js";
import type { HarnessScenario } from "../browser-harness/fixtures.mjs";
import { startHarnessServer, type HarnessServer } from "../browser-harness/server.mjs";

/**
 * One harness stub per test, and the owner page opened against it with its first reads answered.
 *
 * A test names the world with `test.use({ scenario })`. The stub is the same one
 * `pnpm harness:browser` uses, so the page, its Content Security Policy, and the API shapes are
 * identical; only the driver differs. Any console error the page reports fails the test, because
 * an owner who sees the right words beside a broken script is still looking at a broken page.
 */

type OwnerPageFixtures = {
  scenario: HarnessScenario;
  server: HarnessServer;
  owner: Page;
};

export const test = base.extend<OwnerPageFixtures>({
  scenario: ["ready", { option: true }],
  server: async ({ scenario }, use) => {
    const server = await startHarnessServer(scenario);
    await use(server);
    await server.close();
  },
  owner: async ({ page, server }, use) => {
    const consoleErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") {
        consoleErrors.push(message.text());
      }
    });
    page.on("pageerror", (error) => {
      consoleErrors.push(error.message);
    });

    await page.goto(`${server.url}/`);
    await expect(page.locator(`#${ID.conversationState}`)).toHaveText("ok");
    await use(page);

    expect(consoleErrors, "console errors the owner page reported").toEqual([]);
  },
});

export { expect };

export function turnState(page: Page) {
  return page.locator(`#${ID.turnState}`);
}

export function threadRevision(page: Page) {
  return page.locator(`#${ID.threadRevision}`);
}

/** The transcript entries of one role, each read as the text a reader sees under its label. */
export function transcriptTexts(page: Page, role: "user" | "assistant") {
  return page.locator(`#${ID.messageList} > li.${role} > pre.text`);
}

/** Every request the page sent to start a turn, as the stub received it. */
export function turnPosts(server: HarnessServer) {
  return server
    .requests()
    .filter((request) => request.method === "POST" && request.path.endsWith("/turn"));
}

export async function sendTurn(page: Page, prompt: string): Promise<void> {
  await page.getByLabel("prompt").fill(prompt);
  await page.getByRole("button", { name: "Send turn" }).click();
}
