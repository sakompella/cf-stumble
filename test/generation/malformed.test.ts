import { describe, expect, it } from "vitest";

import { buildGeneration } from "../../src/generation/build.js";
import { readGeneration } from "../../src/generation/read.js";
import { decodeObject, encodeObject } from "../../src/git/index.js";
import { parseSha } from "../../src/git/types.js";
import { MemoryStore } from "../../src/storage/memory.js";
import type { Module } from "../../src/generation/types.js";

const author = {
  name: "Build Bot",
  email: "build@example.com",
  timestamp: 1_700_000_000,
  timezoneOffsetMinutes: 0,
} as const;

const validModule = {
  path: "prompt.md",
  content: new TextEncoder().encode("hello\n"),
  executable: false,
} satisfies Module;

function buildValidGeneration(store: MemoryStore) {
  return buildGeneration(store, {
    modules: [validModule],
    parent: undefined,
    author,
    createdAt: author.timestamp,
    summary: "valid",
  });
}

describe("generation module path validation", () => {
  it.each([
    ["empty", ""],
    ["absolute", "/prompt.md"],
    ["parent traversal", "skills/../prompt.md"],
    ["NUL byte", "prompt\0.md"],
  ])("rejects a %s module path before writing objects", async (_label, path) => {
    const store = new MemoryStore();

    await expect(
      buildGeneration(store, {
        modules: [{ ...validModule, path }],
        parent: undefined,
        author,
        createdAt: author.timestamp,
        summary: "invalid",
      }),
    ).rejects.toThrow(/module path/u);
    expect(await store.listObjects()).toHaveLength(0);
  });
});

describe("generation manifest validation", () => {
  it("rejects a manifest that references a missing blob", async () => {
    const store = new MemoryStore();
    const generation = await buildValidGeneration(store);
    const manifestBytes = await store.readObject(generation.manifest);
    if (manifestBytes === undefined) {
      throw new Error("expected a stored manifest");
    }
    const manifest = decodeObject(manifestBytes);
    if (manifest.type !== "tree") {
      throw new Error("expected a tree manifest");
    }
    const file = manifest.entries[0];
    if (file === undefined) {
      throw new Error("expected a manifest entry");
    }
    await store.deleteObject(file.sha);

    await expect(readGeneration(store, generation.sha)).rejects.toThrow(
      /missing.*blob/u,
    );
  });
});

describe("generation commit validation", () => {
  it("rejects a commit whose manifest tree is missing", async () => {
    const store = new MemoryStore();
    const missingTree = parseSha("ffffffffffffffffffffffffffffffffffffffff");
    const commit = await store.writeObject(
      encodeObject({
        type: "commit",
        commit: {
          tree: missingTree,
          parents: [],
          author,
          committer: author,
          message: "missing tree",
        },
      }),
    );

    await expect(readGeneration(store, commit)).rejects.toThrow(/missing.*tree/u);
  });
});
