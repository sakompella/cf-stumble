import { expect, test } from "vitest";
import { parseProjectBudget } from "../../src/workspace/project/budget.js";

test.each([
  [{ remainingMs: 10 }, 10],
  [{ remainingMs: Number.MAX_VALUE }, Number.MAX_VALUE],
] as const)("parses a positive finite project budget", (input, expected) => {
  expect(parseProjectBudget(input)).toBe(expected);
});

test.each([
  undefined,
  { remainingMs: 0 },
  { remainingMs: -1 },
  { remainingMs: Number.NaN },
  { remainingMs: Number.POSITIVE_INFINITY },
])("ignores an invalid project budget: %j", (input) => {
  expect(parseProjectBudget(input)).toBeUndefined();
});
