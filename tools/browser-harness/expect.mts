import type { BrowserPage } from "./chrome.mjs";
import { isJsonRecord, type JsonRecord, type JsonValue } from "./json.mjs";
import type { RecordedRequest } from "./server-state.mjs";

/**
 * The assertions a case makes, worded so a failure reads as a sentence about the page.
 *
 * A browser case fails far from the reader who has to fix it, so the message is the whole
 * deliverable of a failure: it names what was expected, what the page did, and which observation
 * produced it. Nothing here catches or softens a failure — a thrown error is how a case fails, and
 * the runner attaches the case id.
 */

export function assert(held: boolean, message: string): void {
  if (!held) {
    throw new Error(message);
  }
}

export function assertSame<T extends string | number | boolean>(
  actual: T,
  expected: T,
  what: string,
): void {
  assert(actual === expected, `${what}: expected ${String(expected)}, read ${String(actual)}`);
}

export function assertNonEmpty(value: string, what: string): void {
  assert(value.trim() !== "", `${what}: expected some text, read nothing`);
}

export function assertIncludes(haystack: string, needle: string, what: string): void {
  assert(
    haystack.includes(needle),
    `${what}: expected to contain "${needle}", read "${clip(haystack)}"`,
  );
}

export function assertExcludes(haystack: string, needle: string, what: string): void {
  assert(!haystack.includes(needle), `${what}: expected no "${needle}", read "${clip(haystack)}"`);
}

export function assertAtLeast(value: number, minimum: number, what: string): void {
  assert(value >= minimum, `${what}: expected at least ${minimum}, read ${value}`);
}

export function assertAtMost(value: number, maximum: number, what: string): void {
  assert(value <= maximum, `${what}: expected at most ${maximum}, read ${value}`);
}

/** A streamed count that goes down means the page rebuilt the transcript instead of appending. */
export function assertNonDecreasing(values: readonly number[], what: string): void {
  for (const [index, value] of values.entries()) {
    const previous = values[index - 1] ?? value;
    assert(
      value >= previous,
      `${what}: sample ${index} fell from ${previous} to ${value} (${values.join(", ")})`,
    );
  }
}

/** One kind must be rendered before another, which is how a case rejects a reordered transcript. */
export function assertBefore(kinds: readonly string[], earlier: string, later: string): void {
  const first = kinds.indexOf(earlier);
  const second = kinds.indexOf(later);
  assert(first >= 0, `the transcript has no ${earlier} entry (read ${kinds.join(", ")})`);
  assert(second >= 0, `the transcript has no ${later} entry (read ${kinds.join(", ")})`);
  assert(first < second, `the transcript put ${later} at ${second} before ${earlier} at ${first}`);
}

function clip(value: string): string {
  return value.length > 300 ? `${value.slice(0, 300)}…` : value;
}

function canonical(value: JsonValue): string {
  if (!isJsonRecord(value)) {
    return JSON.stringify(value);
  }
  const keys = Object.keys(value).toSorted();
  const fields = keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key] ?? null)}`);
  return `{${fields.join(",")}}`;
}

/** Every request the page made to one method and path, in the order the server received them. */
export function selectRequests(
  requests: readonly RecordedRequest[],
  method: string,
  path: string,
): readonly RecordedRequest[] {
  return requests.filter((request) => request.method === method && request.path === path);
}

/** Every request whose path contains a fragment, for the routes that carry a project id. */
export function selectRequestsLike(
  requests: readonly RecordedRequest[],
  method: string,
  fragment: string,
): readonly RecordedRequest[] {
  return requests.filter((request) => request.method === method && request.path.includes(fragment));
}

/**
 * What left the browser, field for field.
 *
 * Exact equality is the assertion: a body with an extra field is a page sending something the
 * owner never saw, and a body with a substituted epoch is the concurrency guard defeated.
 */
export function assertRequestBody(
  request: RecordedRequest | undefined,
  expected: JsonRecord,
  what: string,
): void {
  assert(request !== undefined, `${what}: the server recorded no such request`);
  const body = request === undefined ? null : request.body;
  assertSame(canonical(body), canonical(expected), `${what} body`);
}

/** A real click that must not land, because the element the case names has no visible box. */
export async function assertClickRefused(
  page: BrowserPage,
  selector: string,
  what: string,
  index = 0,
): Promise<void> {
  try {
    await page.click(selector, index);
  } catch {
    return;
  }
  throw new Error(`${what}: a real click on ${selector} succeeded, so it is still hit-testable`);
}
