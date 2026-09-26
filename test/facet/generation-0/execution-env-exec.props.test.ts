import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { expect, test } from "vitest";
import { resolveTurnDeadlineAt } from "../../../src/facet/generation-0/facet-turn.js";
import { boundedExecTimeout } from "../../../src/facet/generation-0/execution-env-exec.js";
import { TURN_TOOL_TIMEOUT_RESERVE_MS } from "../../../src/facet/generation-0/turn-policy.js";
import { MAX_EXEC_TIMEOUT_MS } from "../../../src/workspace/project/protocol.js";

const requestedTimeout = gs.optional(
  gs.integers({ minValue: 1, maxValue: MAX_EXEC_TIMEOUT_MS * 2 }),
);

const elapsed = gs.integers({ minValue: 0, maxValue: 900_000 });

/** An exec may spend only the turn time left after the reserve, and never exceed the backend cap. */
test("caps every requested exec timeout at the turn budget", () => {
  hegel.test((tc) => {
    const requested = tc.draw(requestedTimeout);
    const elapsedMs = tc.draw(elapsed);
    const turnStartedAt = 1_000_000;
    const deadlineAt = turnStartedAt + 480_000;
    const now = turnStartedAt + elapsedMs;
    const available = deadlineAt - now - TURN_TOOL_TIMEOUT_RESERVE_MS;
    const actual = boundedExecTimeout(requested ?? undefined, now, deadlineAt);

    if (available <= 0) {
      expect(actual).toBeUndefined();

      return;
    }

    expect(actual).toBeDefined();
    expect(actual).toBeLessThanOrEqual(available);
    expect(actual).toBeLessThanOrEqual(MAX_EXEC_TIMEOUT_MS);

    if (requested !== null) expect(actual).toBeLessThanOrEqual(requested);
  });
});

test("refuses a command once only the reserve remains", () => {
  const deadlineAt = 100_000;

  expect(boundedExecTimeout(undefined, deadlineAt - TURN_TOOL_TIMEOUT_RESERVE_MS, deadlineAt)).toBe(
    undefined,
  );
  expect(boundedExecTimeout(undefined, deadlineAt, deadlineAt)).toBeUndefined();
});

test("accepts a future admission deadline and falls back for invalid values", () => {
  const startedAt = 10_000;
  const fallback = startedAt + 480_000;

  expect(resolveTurnDeadlineAt(startedAt + 1, startedAt)).toBe(startedAt + 1);

  for (const invalid of [undefined, null, NaN, Infinity, startedAt - 1, startedAt]) {
    expect(resolveTurnDeadlineAt(invalid, startedAt)).toBe(fallback);
  }
});
