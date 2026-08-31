import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { expect, test } from "vitest";

import { parseGenerationLabel } from "../../src/supervisor/generation-types.js";

test("classifies every safe integer by whether it is non-negative", () => {
  hegel.test((tc) => {
    const value = tc.draw(gs.integers());

    expect(parseGenerationLabel(value) === undefined).toBe(value < 0);
  });
});

test("rejects generated negative safe integers", () => {
  hegel.test((tc) => {
    const value = tc.draw(gs.integers({ minValue: Number.MIN_SAFE_INTEGER, maxValue: -1 }));

    expect(parseGenerationLabel(value)).toBeUndefined();
  });
});

test("rejects generated fractions", () => {
  hegel.test((tc) => {
    const integer = tc.draw(gs.integers({ minValue: -(2 ** 52 - 1), maxValue: 2 ** 52 - 1 }));

    expect(parseGenerationLabel(integer + 0.5)).toBeUndefined();
  });
});

test("rejects non-finite numbers", () => {
  hegel.test((tc) => {
    const value = tc.draw(
      gs.sampledFrom([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]),
    );

    expect(parseGenerationLabel(value)).toBeUndefined();
  });
});
