import { OWNER_PAGE_IDS as ID } from "../../src/page/element-ids.js";
import type { BrowserPage } from "./chrome.mjs";
import { readFocus, type FocusSnapshot } from "./page-layout.mjs";
import { waitForTurnEnded } from "./page-wait.mjs";
import { byId, TOOL_SUMMARY } from "./selectors.mjs";

/**
 * The things a case does to the page, as an owner would.
 *
 * Sending a turn is typing into the composer and pressing the button, not calling the page's own
 * function, because the point of this harness is that the composer works. The keyboard walk is
 * here for the same reason: a case that focused an element with `element.focus()` would prove
 * nothing about tab order.
 */

export async function sendPrompt(page: BrowserPage, prompt: string): Promise<void> {
  await page.type(byId(ID.promptInput), prompt);
  await page.click(byId(ID.sendTurnButton));
}

/** Send a turn and wait for the page to report an ending, whatever that ending is. */
export async function completeTurn(
  page: BrowserPage,
  prompt: string,
  timeoutMs = 30_000,
): Promise<void> {
  await sendPrompt(page, prompt);
  await waitForTurnEnded(page, timeoutMs);
}

/** Open one tool disclosure with a real click on its summary. */
export function openTool(page: BrowserPage, index: number): Promise<void> {
  return page.click(TOOL_SUMMARY, index);
}

/**
 * Press Tab until the named element holds focus, answering every stop passed on the way.
 *
 * The walk is the evidence: a case that wanted the composer and reached it in twelve stops has
 * also proved that no stop before it was a trap, and a case that never reaches it fails with the
 * whole route it did take.
 */
export async function tabUntil(
  page: BrowserPage,
  wanted: (stop: FocusSnapshot) => boolean,
  limit = 40,
): Promise<readonly FocusSnapshot[]> {
  const stops: FocusSnapshot[] = [];

  for (let pressed = 0; pressed < limit; pressed += 1) {
    await page.press("Tab");
    const stop = await readFocus(page);
    stops.push(stop);

    if (wanted(stop)) {
      return stops;
    }
  }

  throw new Error(
    `pressed Tab ${limit} times without reaching the wanted stop; visited ${stops
      .map((stop) => (stop.id === "" ? stop.tag : stop.id))
      .join(" → ")}`,
  );
}

/** Move focus to the document, which is where a keyboard case starts. */
export async function focusDocument(page: BrowserPage): Promise<void> {
  await page.evaluate<boolean>(`(() => {
    if (document.activeElement !== null && document.activeElement !== document.body) {
      document.activeElement.blur();
    }
    return true;
  })()`);
}
