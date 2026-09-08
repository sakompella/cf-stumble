import { OWNER_PAGE_IDS as ID } from "../../src/page/element-ids.js";
import { setTimeout as sleep } from "node:timers/promises";
import type { BrowserPage } from "./chrome.mjs";

/**
 * Waiting for the page, and sampling it while it works.
 *
 * Every wait is expressed as a fact a reader could observe, so a timeout says which observation
 * never arrived rather than which internal promise never settled. The samplers exist because a
 * streamed turn is only provable over time: one snapshot after the stream ends cannot tell a page
 * that rendered incrementally from one that painted everything at the close of the body.
 */

const READING = "reading";

/** Every element the page fills from a read of the owner API, and its "still reading" wording. */
const READ_STATES: readonly string[] = [
  ID.statusStatus,
  ID.projectListStatus,
  ID.conversationState,
];

function textExpression(elementId: string): string {
  return `(document.getElementById(${JSON.stringify(elementId)})?.textContent ?? "")`;
}

/**
 * The state every case starts from: the status, project, and thread reads have all answered.
 *
 * A scenario in which one of those reads is refused settles too — the element then holds the
 * refusal instead of `reading`, which is the observation those cases are about.
 */
export async function waitForSettledReads(page: BrowserPage, timeoutMs = 15_000): Promise<void> {
  const still = READ_STATES.map(
    (elementId) => `${textExpression(elementId)} === ${JSON.stringify(READING)}`,
  ).join(" || ");
  await page.waitFor(`!(${still})`, timeoutMs);
  await sleep(120);
}

export function waitForText(
  page: BrowserPage,
  elementId: string,
  needle: string,
  timeoutMs = 15_000,
): Promise<void> {
  return page.waitFor(
    `${textExpression(elementId)}.includes(${JSON.stringify(needle)})`,
    timeoutMs,
  );
}

export function waitForThreadOk(page: BrowserPage, timeoutMs = 15_000): Promise<void> {
  return page.waitFor(`${textExpression(ID.conversationState)} === "ok"`, timeoutMs);
}

/** A turn has ended when the page has written something other than its running wording. */
export function waitForTurnEnded(page: BrowserPage, timeoutMs = 30_000): Promise<void> {
  const state = textExpression(ID.turnState);
  return page.waitFor(
    `${state} !== "" && ${state} !== "running" && ${state} !== "cancelling"`,
    timeoutMs,
  );
}

export function waitForToolCount(
  page: BrowserPage,
  count: number,
  timeoutMs = 20_000,
): Promise<void> {
  return page.waitFor(
    `document.querySelectorAll("details.tool-call").length >= ${count}`,
    timeoutMs,
  );
}

export function waitForTranscriptText(
  page: BrowserPage,
  needle: string,
  timeoutMs = 20_000,
): Promise<void> {
  return page.waitFor(
    `${textExpression(ID.messageList)}.includes(${JSON.stringify(needle)})`,
    timeoutMs,
  );
}

export function waitForTranscriptEntries(
  page: BrowserPage,
  count: number,
  timeoutMs = 20_000,
): Promise<void> {
  return page.waitFor(
    `(document.getElementById(${JSON.stringify(ID.messageList)})?.children.length ?? 0) >= ${count}`,
    timeoutMs,
  );
}

/**
 * Snapshots taken while a condition holds, at a fixed interval.
 *
 * The last sample is the first one for which `keep` answered false, so a caller receives both the
 * run of intermediate states and the state that ended it.
 */
export async function sampleWhile<T>(
  read: () => Promise<T>,
  keep: (sample: T) => boolean,
  intervalMs = 100,
  timeoutMs = 30_000,
): Promise<readonly T[]> {
  const samples: T[] = [];
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const sample = await read();
    samples.push(sample);
    if (!keep(sample)) {
      return samples;
    }
    if (Date.now() > deadline) {
      throw new Error(`sampled ${samples.length} times in ${timeoutMs}ms without settling`);
    }
    await sleep(intervalMs);
  }
}

export { sleep };
