import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { expect, test } from "vitest";

import { MemoryGenerationRegistry } from "../../src/generation/registry.js";
import { MemoryActivationLedger } from "../../src/pointer/activation.js";
import { parseSha } from "../../src/git/types.js";
import { persistedExamples } from "../support/hegel.js";
import type { GenerationNumber } from "../../src/generation/types.js";

const COMMIT = parseSha("1111111111111111111111111111111111111111");
const POOL_SIZE = 4;

/** Allocate and validate `POOL_SIZE` generations up front; the property only varies what is done
 * with them afterwards. */
async function validatedGenerations(
  registry: MemoryGenerationRegistry,
): Promise<readonly GenerationNumber[]> {
  const numbers: GenerationNumber[] = [];
  for (let index = 0; index < POOL_SIZE; index += 1) {
    const allocated = await registry.allocate({
      commit: COMMIT,
      baseline: undefined,
      idempotencyKey: `generation-${index}`,
      createdAt: index,
    });
    await registry.transition(allocated.number, { state: "loaded" });
    const validated = await registry.transition(allocated.number, { state: "validated" });
    if (validated.outcome !== "transitioned") {
      throw new Error("test setup failed to validate a generation");
    }
    numbers.push(allocated.number);
  }
  return numbers;
}

/**
 * A property layer over `activation.test.ts`, which pins one instance each of promotion,
 * rejection, and rollback. `MemoryActivationLedger`'s append-only event log is the only record of
 * what was ever live, and it has to survive an arbitrary, mixed sequence of promote and rollback
 * calls — including ones that lose their compare-and-swap — not just the one call of each kind a
 * hand-written example exercises. This draws such a sequence and checks the resulting history
 * never desyncs from the pointer, chains together correctly, and never rolls back to a generation
 * that was never actually live.
 */
test("an arbitrary sequence of promote and rollback calls leaves a consistent, chained history", () =>
  hegel.testAsync(async (tc) => {
    const registry = new MemoryGenerationRegistry();
    const ledger = new MemoryActivationLedger({ registry, now: () => 0 });
    const generations = await validatedGenerations(registry);
    const targets = gs.integers({ minValue: 0, maxValue: generations.length - 1 });

    const stepCount = tc.draw(gs.integers({ minValue: 1, maxValue: 15 }));
    for (let step = 0; step < stepCount; step += 1) {
      const target = generations[tc.draw(targets)];
      if (target === undefined) throw new Error("generation index out of range");
      const actual = await ledger.readPointer();
      // Sometimes guess correctly, sometimes hand over a plausible but stale expectation, so the
      // sequence exercises both winning and losing compare-and-swaps.
      const expected = tc.draw(gs.booleans()) ? actual : generations[tc.draw(targets)];

      if (tc.draw(gs.sampledFrom(["promote", "rollback"] as const)) === "promote") {
        await ledger.promote(target, expected);
      } else {
        await ledger.rollback(target, expected);
      }
    }

    const events = await ledger.readEvents();
    const pointer = await ledger.readPointer();

    expect(pointer).toBe(events.at(-1)?.generation);
    const everLive = new Set<GenerationNumber>();
    for (const [index, event] of events.entries()) {
      expect(event.sequence).toBe(index + 1);
      // `from` is whatever was live just before this activation, which can only be undefined for
      // the very first one, or the generation the previous event put live.
      expect(event.from).toBe(index === 0 ? undefined : events[index - 1]?.generation);
      if (event.kind === "rolled_back") {
        // A rollback target has to have been live at some earlier point in this same history —
        // never a generation that only ever existed as a validated candidate.
        expect(everLive.has(event.generation)).toBe(true);
      }
      everLive.add(event.generation);
    }
  }, persistedExamples));
