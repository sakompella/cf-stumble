import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import type { TestCase } from "@hegeldev/hegel";
import { expect, test } from "vitest";

import { buildGeneration } from "../../src/generation/build.js";
import { walkLineage } from "../../src/generation/lineage.js";
import { MemoryStore } from "../../src/storage/memory.js";
import { moduleSets } from "../support/generation-generators.js";
import { persistedExamples } from "../support/hegel.js";
import { expectOk } from "../support/result.js";
import type { CommitSnapshot } from "../../src/generation/types.js";

/**
 * A property layer over `lineage.test.ts`, which pins one three-generation chain, one missing
 * parent, and one hand-constructed cycle. `walkLineage` is the read path a rollback decision or an
 * audit trail depends on, so its shape has to hold over chains of arbitrary length, not just the
 * one length that was pinned by hand: it should terminate, visit each generation once, and end at
 * a commit with no parent.
 */

const author = {
  name: "Build Bot",
  email: "build@example.com",
  timestamp: 1_700_000_000,
  timezoneOffsetMinutes: 0,
} as const;

/** Build a chain of `count` generations, each parented on the one before it, oldest first. */
async function buildChain(
  store: MemoryStore,
  tc: TestCase,
  count: number,
): Promise<readonly CommitSnapshot[]> {
  const chain: CommitSnapshot[] = [];
  let parent: CommitSnapshot | undefined;
  for (let index = 0; index < count; index += 1) {
    const built = expectOk(
      await buildGeneration(store, {
        modules: tc.draw(moduleSets),
        parent,
        author,
        createdAt: author.timestamp + index,
        summary: `generation ${index}`,
      }),
    );
    chain.push(built);
    parent = built;
  }
  return chain;
}

test("walking lineage from the tip returns the whole chain, newest first, ending at genesis", () =>
  hegel.testAsync(async (tc) => {
    const count = tc.draw(gs.integers({ minValue: 1, maxValue: 6 }));
    const store = new MemoryStore();
    const chain = await buildChain(store, tc, count);
    const tip = chain.at(-1);
    if (tip === undefined) throw new Error("chain was unexpectedly empty");

    const lineage = expectOk(await walkLineage(store, tip.sha));

    expect(lineage.map((commit) => commit.sha)).toEqual(
      chain.toReversed().map((commit) => commit.sha),
    );
    expect(lineage.at(-1)?.parent).toBeUndefined();
    expect(new Set(lineage.map((commit) => commit.sha)).size).toBe(lineage.length);
  }, persistedExamples));

test("the ancestry of any generation in a chain is a suffix of the full ancestry", () =>
  hegel.testAsync(async (tc) => {
    const count = tc.draw(gs.integers({ minValue: 1, maxValue: 6 }));
    const store = new MemoryStore();
    const chain = await buildChain(store, tc, count);
    const tip = chain.at(-1);
    if (tip === undefined) throw new Error("chain was unexpectedly empty");
    const index = tc.draw(gs.integers({ minValue: 0, maxValue: count - 1 }));
    const ancestor = chain[index];
    if (ancestor === undefined) throw new Error("chain index out of range");

    const fullLineage = expectOk(await walkLineage(store, tip.sha));
    const ancestorLineage = expectOk(await walkLineage(store, ancestor.sha));

    // `fullLineage` runs newest to oldest, so the ancestor's own ancestry is whatever is left
    // after dropping the generations newer than it.
    expect(ancestorLineage.map((commit) => commit.sha)).toEqual(
      fullLineage.slice(count - 1 - index).map((commit) => commit.sha),
    );
  }, persistedExamples));
