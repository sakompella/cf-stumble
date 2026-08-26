import { describe, expect, it } from "vitest";

import { decodeObject } from "../../src/git/index.js";
import type { Commit, Sha } from "../../src/git/types.js";
import { MemoryStore } from "../../src/storage/memory.js";
import { buildGeneration } from "../../src/generation/build.js";
import type { Module } from "../../src/generation/types.js";

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
  const object = decodeObject(bytes);
  if (object.type !== "commit") {
    throw new Error(`expected commit, got ${object.type}`);
  }
  return object.commit;
}

describe("buildGeneration", () => {
  it("writes a root generation with a manifest commit", async () => {
    const store = new MemoryStore();
    const generation = await buildGeneration(store, options);

    expect(generation.number).toBe(0);
    expect(generation.parent).toBeUndefined();
    expect(generation.createdAt).toBe(author.timestamp);
    expect(generation.summary).toBe(`${options.summary}\n`);
    expect(await readCommit(store, generation.sha)).toEqual({
      tree: generation.manifest,
      parents: [],
      author,
      committer: author,
      message: `${options.summary}\n`,
    });
    expect(await store.listObjects()).toHaveLength(4);
  });

  it("deduplicates an unchanged module across generations", async () => {
    const store = new MemoryStore();
    const first = await buildGeneration(store, options);

    await buildGeneration(store, {
      ...options,
      parent: first,
      summary: "same module, next generation",
      createdAt: author.timestamp + 1,
    });

    expect(await store.listObjects()).toHaveLength(5);
  });

  it("is deterministic for identical inputs", async () => {
    const store = new MemoryStore();

    const first = await buildGeneration(store, options);
    const second = await buildGeneration(store, options);

    expect(second).toEqual(first);
    expect(await store.listObjects()).toHaveLength(4);
  });
});
