import type { Route } from "@playwright/test";
import { seedExchange } from "../browser-harness/conversations.mjs";
import { HARNESS_PROJECT_ID } from "../browser-harness/fixtures.mjs";
import { expect, sendMessage, test, toolCalls, transcriptTexts, turnState } from "./fixtures.mjs";

test.use({ scenario: "rendered" });

const PROMPT = "Rename the sidebar heading to Projects";

const WATCH_MARKDOWN = `
  window.markdownAdded = [];
  window.markdownUpdates = new Map();
  new MutationObserver((records) => {
    for (const record of records) {
      const target = record.target instanceof Element ? record.target : record.target.parentElement;
      const markdown = target?.closest("stumble-markdown");
      if (markdown) {
        window.markdownUpdates.set(markdown, (window.markdownUpdates.get(markdown) ?? 0) + 1);
      }
      for (const node of record.addedNodes) {
        if (node instanceof Element) {
          window.markdownAdded.push(...node.querySelectorAll("stumble-markdown"));
        }
      }
    }
  }).observe(document.body, { childList: true, subtree: true, characterData: true });
`;

const REPLY_GROWTH = `(() => {
  const created = window.markdownAdded.filter((added) => added.querySelector("table") !== null);
  const [reply] = created;
  return {
    created: created.length,
    isShown: reply !== undefined && reply.isConnected,
    updates: reply === undefined ? 0 : (window.markdownUpdates.get(reply) ?? 0),
  };
})()`;

const COLOURS = `new Set([...document.querySelectorAll("stumble-markdown pre code span")].map((span) => getComputedStyle(span).color)).size`;

test("a streamed reply renders its table and highlighted code, patching one element as it grows", async ({
  owner,
}) => {
  await owner.evaluate(WATCH_MARKDOWN);

  await sendMessage(owner, PROMPT);
  await expect(turnState(owner)).toHaveText("answered");

  const reply = transcriptTexts(owner, "assistant").filter({ has: owner.locator("table") });

  await expect(reply).toContainText("the heading was <b>Repositories</b>:");
  await expect(reply.locator("b")).toHaveCount(0);
  await expect(reply.locator("td").first()).toHaveText("src/sidebar.ts");
  await expect(reply.locator("pre code")).toHaveText('const heading = "Projects";');

  expect(await owner.evaluate<number>(COLOURS)).toBeGreaterThan(1);

  const growth = await owner.evaluate<{ created: number; isShown: boolean; updates: number }>(
    REPLY_GROWTH,
  );

  expect(growth.created).toBe(1);
  expect(growth.isShown).toBe(true);
  expect(growth.updates).toBeGreaterThan(1);
});

test("a diff in tool output and a file edit render as word-level diffs", async ({ owner }) => {
  await sendMessage(owner, PROMPT);
  await expect(turnState(owner)).toHaveText("answered");

  const bash = toolCalls(owner).filter({ hasText: "bash — done" });
  const edit = toolCalls(owner).filter({ hasText: "edit — done" });

  await bash.locator("summary").click();
  await edit.locator("summary").click();

  await expect(bash.locator("[data-line]")).toHaveCount(4);
  await expect(bash.locator("[data-diff-span]")).toHaveText(["Repositories", "Projects"]);
  await expect(bash.locator("bdi")).toHaveText("src/sidebar.ts");
  await expect(bash.locator(".tool-output")).toBeHidden();
  await expect(edit.locator("bdi")).toHaveText("src/footer.ts");
  await expect(edit.locator("[data-diff-span]")).toHaveText(["old", "new"]);
});

const MARK_REPLY = `document.querySelector("stumble-markdown").dataset.before = "plain"`;

test("before the Pierre script arrives a reply shows its plain text, and the same element renders it after", async ({
  page,
  server,
}) => {
  const held: Route[] = [];

  await page.route("**/assets/pierre-*.js", (route) => {
    held.push(route);
  });
  await page.goto(`${server.url}/`);

  const reply = transcriptTexts(page, "assistant").first();

  await expect(reply).toHaveText(seedExchange(HARNESS_PROJECT_ID).reply);
  await expect(reply.locator("a")).toHaveCount(0);
  await page.evaluate(MARK_REPLY);

  await Promise.all(held.map((route) => route.continue()));

  await expect(reply).toHaveAttribute("data-markdown", "root");
  await expect(reply).toHaveAttribute("data-before", "plain");
  await expect(reply.locator("a")).toHaveAttribute("href", /^https:\/\/github\.com\//u);
});
