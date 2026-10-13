import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { expect, test } from "vitest";

import { parseProviderChunk } from "../src/model-route-stream-parse.js";

const tokenCandidates = gs.oneOf(
  gs.integers({ minValue: -1_000, maxValue: 1_000_000 }),
  gs.floats({ allowNan: false, allowInfinity: false }),
);

function isTokenCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

test("reported usage is kept only when both counts are non-negative whole numbers", () => {
  hegel.test((tc) => {
    const prompt = tc.draw(tokenCandidates);
    const completion = tc.draw(tokenCandidates);

    const { usage } =
      parseProviderChunk({ usage: { prompt_tokens: prompt, completion_tokens: completion } }) ?? {};

    expect(usage).toEqual(
      isTokenCount(prompt) && isTokenCount(completion)
        ? { inputTokens: prompt, outputTokens: completion }
        : undefined,
    );
  });
});
