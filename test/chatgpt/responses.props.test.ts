import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { expect, test } from "vitest";
import { retryAt } from "../../src/chatgpt/responses.js";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const clock = gs.integers({ minValue: 1e12, maxValue: 2e12 });

const padding = gs.text({ alphabet: " \t", maxSize: 3 });

test("a missing, empty or zero Retry-After names no end", () => {
  expect(retryAt(null, 1e12)).toBeNull();
  expect(retryAt("", 1e12)).toBeNull();
  expect(retryAt("0", 1e12)).toBeNull();
});

test("whatever the header says, the end is absent or within the next week", () => {
  hegel.test((tc) => {
    const now = tc.draw(clock);
    const end = retryAt(tc.draw(gs.text({ maxSize: 30 })), now);

    expect(end ?? now + 1).toBeGreaterThan(now);
    expect(end ?? now).toBeLessThanOrEqual(now + WEEK_MS);
  });
});

test("a count of seconds ends that long from now, capped at a week, and zero ends nothing", () => {
  hegel.test((tc) => {
    const now = tc.draw(clock);
    const seconds = tc.draw(gs.integers({ minValue: 0, maxValue: 1e9 }));
    const zeros = "0".repeat(tc.draw(gs.integers({ minValue: 0, maxValue: 3 })));
    const header = `${tc.draw(padding)}${zeros}${seconds}${tc.draw(padding)}`;

    expect(retryAt(header, now)).toBe(
      seconds === 0 ? null : now + Math.min(seconds * 1000, WEEK_MS),
    );
  });
});

test("an HTTP date ends at that second if it is ahead, capped at a week, and nothing if it is not", () => {
  hegel.test((tc) => {
    const now = tc.draw(clock);
    const sentAt = now + tc.draw(gs.integers({ minValue: -1e10, maxValue: 1e10 }));
    const wholeSecond = Math.floor(sentAt / 1000) * 1000;

    expect(retryAt(new Date(sentAt).toUTCString(), now)).toBe(
      wholeSecond > now ? Math.min(wholeSecond, now + WEEK_MS) : null,
    );
  });
});
