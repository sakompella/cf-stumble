import * as gs from "@hegeldev/hegel/generators";

import type { Module } from "../../src/generation/types.js";

/**
 * Generators for `src/generation/`, shared by the property tests over `build.ts`, `read.ts`, and
 * `lineage.ts`.
 *
 * Module paths are kept to a single segment — no `/` — so every generated set is automatically
 * free of the conflict `insertModule` rejects, where one name is used as both a file and a
 * directory. Nested paths are already exercised by hand-picked examples in the `.test.ts`
 * siblings, so generating them here would mean re-deriving `insertModule`'s own conflict rules
 * just to filter them back out.
 */
export const moduleNames = gs
  .text({ minSize: 1, maxSize: 12, excludeCharacters: "/\0", excludeCategories: ["Cs"] })
  .filter((name) => name !== "." && name !== "..");

/** Module content, empty included: `binary()`'s default minimum size is zero. */
export const moduleContent = gs.binary({ maxSize: 64 }).map((data) => Uint8Array.from(data));

/** A set of modules with distinct top-level names, so `buildGeneration` never rejects it. */
export const moduleSets = gs.composite<readonly Module[]>((tc) => {
  const names = tc.draw(gs.arrays(moduleNames, { maxSize: 8, unique: true }));
  return names.map((path) => ({
    path,
    content: tc.draw(moduleContent),
    executable: tc.draw(gs.booleans()),
  }));
});
