import { expect, it } from "vitest";

import { decodeObject } from "../../src/git/index.js";
import type { Commit, Sha } from "../../src/git/types.js";
import { MemoryStore } from "../../src/storage/memory.js";
import type { SweepableStore } from "../../src/storage/types.js";
import { buildGeneration } from "../../src/generation/build.js";
import type { Module } from "../../src/generation/types.js";
import { expectOk } from "../support/result.js";

const author = {
  name: "Build Bot",
  email: "build@example.com",
  timestamp: 1_700_000_000,
  timezoneOffsetMinutes: 0,
} as const;

const module = {
  path: "prompts/system.md",
  content: new TextEncoder().encode("Be concise.\n"),
  executable: false,
} satisfies Module;

const options = {
  modules: [module],
  parent: undefined,
  author,
  createdAt: author.timestamp,
  summary: "initial generation",
} as const;

async function readCommit(store: MemoryStore, sha: Sha): Promise<Commit> {
  const bytes = await store.readObject(sha);
  if (bytes === undefined) {
    throw new Error("expected a stored commit");
  }
  const object = expectOk(decodeObject(bytes));
  if (object.type !== "commit") {
    throw new Error(`expected commit, got ${object.type}`);
  }
  return object.commit;
}

it("buildGeneration writes a root commit with a manifest", async () => {
  const store = new MemoryStore();
  const commit = await buildGeneration(store, options);

  expect(commit).not.toHaveProperty("number");
  expect(commit.parent).toBeUndefined();
  expect(commit.createdAt).toBe(author.timestamp);
  expect(commit.summary).toBe(`${options.summary}\n`);
  expect(await readCommit(store, commit.sha)).toEqual({
    tree: commit.manifest,
    parents: [],
    author,
    committer: author,
    message: `${options.summary}\n`,
  });
  expect(await store.listObjects()).toHaveLength(4);
});

it("buildGeneration deduplicates an unchanged module across commits", async () => {
  const store: SweepableStore = new MemoryStore();
  const first = await buildGeneration(store, options);

  await buildGeneration(store, {
    ...options,
    parent: first,
    summary: "same module, next commit",
    createdAt: author.timestamp + 1,
  });

  expect(await store.listObjects()).toHaveLength(5);
});

it("buildGeneration does not assign a colliding lineage identity to distinct commits", async () => {
  const store = new MemoryStore();
  const parent = await buildGeneration(store, options);
  const left = await buildGeneration(store, {
    ...options,
    parent,
    summary: "candidate left",
    createdAt: author.timestamp + 1,
  });
  const right = await buildGeneration(store, {
    ...options,
    parent,
    summary: "candidate right",
    createdAt: author.timestamp + 1,
  });

  expect(left.sha).not.toBe(right.sha);
  expect(left).not.toHaveProperty("number");
  expect(right).not.toHaveProperty("number");
});

it("buildGeneration is deterministic for identical inputs", async () => {
  const store = new MemoryStore();

  const first = await buildGeneration(store, options);
  const second = await buildGeneration(store, options);

  expect(second).toEqual(first);
  expect(await store.listObjects()).toHaveLength(4);
});
