import { expect, test } from "vitest";
import { parseGenerationLabel } from "../../src/supervisor/generation-types.js";

test("parses non-negative safe integer generation labels", () => {
  expect(parseGenerationLabel(0)).toBe(0);
  expect(parseGenerationLabel(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
});

test.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
  "rejects an invalid generation label %p",
  (value) => {
    expect(parseGenerationLabel(value)).toBeUndefined();
  },
);
