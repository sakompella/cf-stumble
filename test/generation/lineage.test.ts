import { describe, expect, it } from "vitest";

import { buildGeneration } from "../../src/generation/build.js";
import { walkLineage } from "../../src/generation/lineage.js";
import { encodeObject } from "../../src/git/index.js";
import { parseSha } from "../../src/git/types.js";
import { MemoryStore } from "../../src/storage/memory.js";
import type { Generation, Module } from "../../src/generation/types.js";

const author = {
  name: "Build Bot",
  email: "build@example.com",
  timestamp: 1_700_000_000,
  timezoneOffsetMinutes: 0,
} as const;

const module = {
  path: "prompt.md",
  content: new TextEncoder().encode("hello\n"),
  executable: false,
} satisfies Module;

function build(
  store: MemoryStore,
  parent: Generation | undefined,
  createdAt: number,
  summary: string,
): Promise<Generation> {
  return buildGeneration(store, {
    modules: [module],
    parent,
    author,
    createdAt,
    summary,
  });
}

describe("walkLineage", () => {
  it("returns the starting generation followed by its ancestors", async () => {
    const store = new MemoryStore();
    const root = await build(store, undefined, author.timestamp, "root");
    const child = await build(store, root, author.timestamp + 1, "child");
    const grandchild = await build(
      store,
      child,
      author.timestamp + 2,
      "grandchild",
    );

    const lineage = await walkLineage(store, grandchild.sha);

    expect(lineage.map((generation) => generation.sha)).toEqual([
      grandchild.sha,
      child.sha,
      root.sha,
    ]);
    expect(lineage.map((generation) => generation.number)).toEqual([2, 1, 0]);
    expect(lineage.at(-1)?.parent).toBeUndefined();
  });

  it("fails cleanly when a parent object is missing", async () => {
    const store = new MemoryStore();
    const root = await build(store, undefined, author.timestamp, "root");
    const missingParent = parseSha("ffffffffffffffffffffffffffffffffffffffff");
    const broken = await store.writeObject(
      encodeObject({
        type: "commit",
        commit: {
          tree: root.manifest,
          parents: [missingParent],
          author,
          committer: author,
          message: "broken",
        },
      }),
    );

    await expect(walkLineage(store, broken)).rejects.toThrow(/missing.*commit/u);
  });
});
