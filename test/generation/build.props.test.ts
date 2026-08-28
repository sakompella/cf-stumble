import * as hegel from "@hegeldev/hegel";
import { expect, test } from "vitest";

import { buildGeneration } from "../../src/generation/build.js";
import { MemoryStore } from "../../src/storage/memory.js";
import { moduleSets } from "../support/generation-generators.js";
import { persistedExamples } from "../support/hegel.js";
import { expectOk } from "../support/result.js";

/**
 * A property layer over `build.test.ts`, which pins one root commit and one dedup case.
 * `buildGeneration` writes each module as an independent blob and only assembles them into a tree
 * at the end, so authored order and on-disk order are two different things by construction — the
 * manifest's git-level sort is the only thing that is supposed to stand between them.
 */

const author = {
  name: "Build Bot",
  email: "build@example.com",
  timestamp: 1_700_000_000,
  timezoneOffsetMinutes: 0,
} as const;

test("the commit built for a module set does not depend on the order modules were authored in", () =>
  hegel.testAsync(async (tc) => {
    const modules = tc.draw(moduleSets);
    const options = {
      parent: undefined,
      author,
      createdAt: author.timestamp,
      summary: "generated",
    } as const;

    const forward = expectOk(await buildGeneration(new MemoryStore(), { ...options, modules }));
    const reversed = expectOk(
      await buildGeneration(new MemoryStore(), { ...options, modules: modules.toReversed() }),
    );

    expect(reversed).toEqual(forward);
  }, persistedExamples));
