import { OWNER_PAGE_IDS as ID } from "../../../src/page/element-ids.js";
import type { HarnessCase } from "../case.mjs";
import { assertSame } from "../expect.mjs";

/**
 * The smallest end-to-end proof that this harness drives a real browser against the real page.
 *
 * It is deliberately independent of the page's layout and of most of its identifiers, so it keeps
 * working while the page is being rewritten: it asserts that the document arrived, that the root
 * element the page declares is present, and that the inline script actually ran — the browser
 * recorded a fetch to the owner API, which only the page's own script issues. The runner's own
 * checks cover the rest, because a smoke case that also had to prove no fault occurred would be
 * asserting what every case already asserts.
 */
export const CASES: readonly HarnessCase[] = [
  {
    id: "SMOKE-1",
    title: "the harness drives the real owner page",
    rank: "must",
    scenario: "ready",
    start: "loaded",
    run: async ({ page }) => {
      assertSame(await page.evaluate<string>("document.title"), "cf-stumble", "the page title");
      assertSame(
        await page.evaluate<boolean>(`document.getElementById("${ID.root}") !== null`),
        true,
        `the page has an element with id ${ID.root}`,
      );
      await page.waitFor(
        `performance.getEntriesByType("resource").some((entry) => entry.name.includes("/api/"))`,
        10_000,
      );

      return "the document loaded, declared its root element, and its inline script called the owner API";
    },
  },
];
