import * as hegel from "@hegeldev/hegel";
import { expect, test } from "vitest";

import { buildGeneration } from "../../src/generation/build.js";
import { readGeneration } from "../../src/generation/read.js";
import { MemoryStore } from "../../src/storage/memory.js";
import { moduleSets } from "../support/generation-generators.js";
import { persistedExamples } from "../support/hegel.js";
import { expectOk } from "../support/result.js";
import type { Module } from "../../src/generation/types.js";

/**
 * A property layer over `read.test.ts`, which round-trips two hand-picked modules including one
 * nested path. `buildGeneration` writes a manifest as nested Git trees and `readGeneration` walks
 * them back into a flat module list, so this is the boundary where a wrong tree walk, a dropped
 * executable bit, or a truncated blob would show up as a generation loading different content
 * than an agent actually wrote — for an arbitrary set of modules rather than one fixed pair.
 */

const author = {
  name: "Build Bot",
  email: "build@example.com",
  timestamp: 1_700_000_000,
  timezoneOffsetMinutes: 0,
} as const;

function byPath(modules: readonly Module[]): Module[] {
  return modules.toSorted((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
}

test("reading back a built generation returns exactly the modules that were built", () =>
  hegel.testAsync(async (tc) => {
    const modules = tc.draw(moduleSets);
    const store = new MemoryStore();

    const built = expectOk(
      await buildGeneration(store, {
        modules,
        parent: undefined,
        author,
        createdAt: author.timestamp,
        summary: "generated",
      }),
    );
    const loaded = expectOk(await readGeneration(store, built.sha));

    expect(loaded.generation).toEqual(built);
    expect(byPath(loaded.modules)).toEqual(byPath(modules));
  }, persistedExamples));
