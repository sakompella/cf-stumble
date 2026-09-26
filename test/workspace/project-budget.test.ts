import { expect, test } from "vitest";
import { parseProjectBudget } from "../../src/workspace/host.js";

test.each([
  [{ remainingMs: 10 }, 10],
  [{ remainingMs: Number.MAX_VALUE }, Number.MAX_VALUE],
] as const)("parses a positive finite project budget", (input, expected) => {
  expect(parseProjectBudget(input)).toBe(expected);
});

test.each([
  undefined,
  null,
  10,
  { remainingMs: 0 },
  { remainingMs: -1 },
  { remainingMs: Number.NaN },
  { remainingMs: Number.POSITIVE_INFINITY },
  { remainingMs: "10" },
  { remainingMs: 10, extra: true },
])("ignores an invalid project budget: %j", (input) => {
  expect(parseProjectBudget(input)).toBeUndefined();
});
