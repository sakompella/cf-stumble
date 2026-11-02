import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { expect, test } from "vitest";

import { isGenerationLabel } from "../../../src/supervisor/generations.js";

const safeIntegers = gs.integers().map((value) => ({ value, accepted: value >= 0 }));

const fractions = gs
  .integers({ minValue: -(2 ** 52 - 1), maxValue: 2 ** 52 - 1 })
  .map((integer) => ({ value: integer + 0.5, accepted: false }));

const nonFinite = gs
  .sampledFrom([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])
  .map((value) => ({ value, accepted: false }));

test("accepts a number as a label exactly when it is a non-negative integer", () => {
  hegel.test((tc) => {
    const { value, accepted } = tc.draw(gs.oneOf(safeIntegers, fractions, nonFinite));

    expect(isGenerationLabel(value)).toBe(accepted);
  });
});
