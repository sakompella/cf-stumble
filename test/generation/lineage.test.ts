import { expect, it } from "vitest";

import { buildGeneration } from "../../src/generation/build.js";
import { walkLineage } from "../../src/generation/lineage.js";
import { encodeObject } from "../../src/git/index.js";
import { parseSha } from "../../src/git/types.js";
import type { Sha } from "../../src/git/types.js";
import { MemoryStore } from "../../src/storage/memory.js";
import type { Store } from "../../src/storage/types.js";
import type { CommitSnapshot, Module } from "../../src/generation/types.js";

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
  parent: CommitSnapshot | undefined,
  createdAt: number,
  summary: string,
): Promise<CommitSnapshot> {
  return buildGeneration(store, {
    modules: [module],
    parent,
    author,
    createdAt,
    summary,
  });
}

function noPointer(): Promise<Sha | undefined> {
  return new Promise<Sha | undefined>((resolve) => {
    resolve();
  });
}

it("walkLineage returns the starting commit followed by its ancestors", async () => {
  const store = new MemoryStore();
  const root = await build(store, undefined, author.timestamp, "root");
  const child = await build(store, root, author.timestamp + 1, "child");
  const grandchild = await build(store, child, author.timestamp + 2, "grandchild");

  const lineage = await walkLineage(store, grandchild.sha);

  expect(lineage.map((generation) => generation.sha)).toEqual([
    grandchild.sha,
    child.sha,
    root.sha,
  ]);
  expect(lineage.at(-1)?.parent).toBeUndefined();
});

it("walkLineage fails cleanly when a parent object is missing", async () => {
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

it("walkLineage fails cleanly when commit ancestry contains a cycle", async () => {
  const start = parseSha("a".repeat(40));
  const tree = parseSha("b".repeat(40));
  const commitBytes = encodeObject({
    type: "commit",
    commit: {
      tree,
      parents: [start],
      author,
      committer: author,
      message: "cyclic",
    },
  });

  const store: Store = {
    readObject: (sha) =>
      Promise.resolve(
        sha === start
          ? commitBytes
          : sha === tree
            ? encodeObject({ type: "tree", entries: [] })
            : undefined,
      ),
    writeObject: () => Promise.reject(new Error("not used")),
    readPointer: noPointer,
    setPointer: () => Promise.resolve(false),
  };

  await expect(walkLineage(store, start)).rejects.toThrow(/lineage cycle/u);
});
