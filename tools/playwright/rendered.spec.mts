import { expect, sendMessage, test, toolCalls, transcriptTexts, turnState } from "./fixtures.mjs";

test.use({ scenario: "rendered" });

const PROMPT = "Rename the sidebar heading to Projects";

test("a streamed reply renders its table and highlighted code, patching one element as it grows", async ({
  owner,
}) => {
  await owner.evaluate(() => {
    const added: Element[] = [];
    const updates = new Map<Element, number>();

    new MutationObserver((records) => {
      for (const record of records) {
        const element =
          record.target instanceof Element ? record.target : record.target.parentElement;
        const markdown = element?.closest("stumble-markdown");

        if (markdown === null || markdown === undefined) {
          added.push(
            ...[...record.addedNodes]
              .filter((node) => node instanceof Element && node.matches("li"))
              .flatMap((node) => [...(node as Element).querySelectorAll("stumble-markdown")]),
          );
        } else {
          updates.set(markdown, (updates.get(markdown) ?? 0) + 1);
        }
      }
    }).observe(document.body, { childList: true, subtree: true, characterData: true });

    Object.assign(window, { markdownAdded: added, markdownUpdates: updates });
  });

  await sendMessage(owner, PROMPT);
  await expect(turnState(owner)).toHaveText("answered");

  const reply = transcriptTexts(owner, "assistant").filter({ has: owner.locator("table") });

  await expect(reply.locator("td").first()).toHaveText("src/sidebar.ts");
  await expect(reply.locator("pre code")).toHaveText('const heading = "Projects";');

  const colours = await reply
    .locator("pre code span")
    .evaluateAll((spans) => new Set(spans.map((span) => getComputedStyle(span).color)).size);

  expect(colours).toBeGreaterThan(1);

  const growth = await reply.evaluate((element) => {
    const { markdownAdded, markdownUpdates } = window as unknown as {
      markdownAdded: Element[];
      markdownUpdates: Map<Element, number>;
    };

    return {
      created: markdownAdded.filter((added) => added.querySelector("table") !== null).length,
      isSame: markdownAdded.includes(element),
      updates: markdownUpdates.get(element) ?? 0,
    };
  });

  expect(growth.created).toBe(1);
  expect(growth.isSame).toBe(true);
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
