import { describe, expect, it } from "vitest";

import { buildGeneration as buildGenerationResult } from "../../src/generation/build.js";
import { readGeneration } from "../../src/generation/read.js";
import { decodeObject, encodeObject } from "../../src/git/index.js";
import { parseSha } from "../../src/git/types.js";
import { MemoryStore } from "../../src/storage/memory.js";
import type { Module } from "../../src/generation/types.js";
import { expectErr, expectOk } from "../support/result.js";

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

async function buildValidGeneration(store: MemoryStore) {
  return expectOk(
    await buildGenerationResult(store, {
      modules: [validModule],
      parent: undefined,
      author,
      createdAt: author.timestamp,
      summary: "valid",
    }),
  );
}

describe("generation module path validation", () => {
  it.each([
    ["empty", ""],
    ["absolute", "/prompt.md"],
    ["parent traversal", "skills/../prompt.md"],
    ["NUL byte", "prompt\0.md"],
  ])("rejects a %s module path before writing objects", async (_label, path) => {
    const store = new MemoryStore();

    const error = expectErr(
      await buildGenerationResult(store, {
        modules: [{ ...validModule, path }],
        parent: undefined,
        author,
        createdAt: author.timestamp,
        summary: "invalid",
      }),
    );
    expect(error).toMatchObject({
      _tag: "InvalidGenerationInputError",
      condition: "invalid-module-path",
    });
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
    const manifest = expectOk(decodeObject(manifestBytes));
    if (manifest.type !== "tree") {
      throw new Error("expected a tree manifest");
    }
    const file = manifest.entries[0];
    if (file === undefined) {
      throw new Error("expected a manifest entry");
    }
    await store.deleteObject(file.sha);

    await expect(readGeneration(store, generation.sha)).rejects.toThrow(/missing.*blob/u);
    await expect(readGeneration(store, generation.sha)).rejects.toMatchObject({ _tag: "Panic" });
  });
});

describe("generation commit validation", () => {
  it("rejects a commit whose manifest tree is missing", async () => {
    const store = new MemoryStore();
    const missingTree = parseSha("ffffffffffffffffffffffffffffffffffffffff");
    const commit = expectOk(
      await store.writeObject(
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
      ),
    );

    await expect(readGeneration(store, commit)).rejects.toThrow(/missing.*tree/u);
    await expect(readGeneration(store, commit)).rejects.toMatchObject({ _tag: "Panic" });
  });
});
