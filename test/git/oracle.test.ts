import { describe, expect, it } from "vitest";

import { buildGeneration as buildGenerationResult } from "../../src/generation/build.js";
import { MemoryStore } from "../../src/storage/memory.js";
import { decodeObject, FILE_MODE, parseSha } from "../../src/git/index.js";
import type { GitObject } from "../../src/git/index.js";
import type { Module } from "../../src/generation/types.js";
import { assertOracleAgreement } from "../support/git-oracle.js";
import { expectOk } from "../support/result.js";

describe("isomorphic-git codec oracle", () => {
  it("agrees on blob hashes and reads blobs in both directions", async () => {
    const cases = [new Uint8Array(), Uint8Array.from([0, 1, 2, 255, 0])];

    for (const data of cases) {
      await assertOracleAgreement({ type: "blob", data });
    }
  });

  it("agrees on nested tree hashes and exercises directory sorting", async () => {
    await assertNestedTreeAgreement();
  });

  it("agrees on unicode merge commits with signed timezone offsets", async () => {
    await assertOracleAgreement({
      type: "commit",
      commit: {
        tree: parseSha("0123456789012345678901234567890123456789"),
        parents: [
          parseSha("1111111111111111111111111111111111111111"),
          parseSha("2222222222222222222222222222222222222222"),
        ],
        author: {
          name: "Zoë 内容",
          email: "zoe@example.com",
          timestamp: 1_700_000_000,
          timezoneOffsetMinutes: -330,
        },
        committer: {
          name: "生成者",
          email: "committer@example.com",
          timestamp: 1_700_000_001,
          timezoneOffsetMinutes: 530,
        },
        message: "merge: café 内容\n",
      },
    });
  });
});

describe("generation commit messages", () => {
  it("normalizes summaries to one trailing newline", async () => {
    const store = new MemoryStore();
    const author = {
      name: "Build Bot",
      email: "build@example.com",
      timestamp: 1_700_000_000,
      timezoneOffsetMinutes: 0,
    };
    const module = {
      path: "prompt.md",
      content: new TextEncoder().encode("prompt\n"),
      executable: false,
    } satisfies Module;
    const generation = expectOk(
      await buildGenerationResult(store, {
        modules: [module],
        parent: undefined,
        author,
        createdAt: author.timestamp,
        summary: "unicode summary\n\n",
      }),
    );
    const bytes = await store.readObject(generation.sha);
    if (bytes === undefined) {
      throw new Error("expected a stored generation commit");
    }
    const object = expectOk(decodeObject(bytes));
    if (object.type !== "commit") {
      throw new Error(`expected a commit, got ${object.type}`);
    }
    expect(object.commit.message).toBe("unicode summary\n");
  });
});

async function assertNestedTreeAgreement(): Promise<void> {
  const leaf = await assertOracleAgreement({
    type: "blob",
    data: new TextEncoder().encode("nested leaf\n"),
  });
  const subtree: GitObject = {
    type: "tree",
    entries: [
      { mode: FILE_MODE.regular, name: "leaf", sha: leaf },
      { mode: FILE_MODE.executable, name: "内容", sha: leaf },
    ],
  };
  const subtreeSha = await assertOracleAgreement(subtree);
  const root: GitObject = {
    type: "tree",
    // Deliberately place the directory first. Git's wire order puts foo.txt first because
    // the directory name compares as "foo/", not merely as "foo".
    entries: [
      { mode: FILE_MODE.tree, name: "foo", sha: subtreeSha },
      { mode: FILE_MODE.regular, name: "foo.txt", sha: leaf },
      { mode: FILE_MODE.regular, name: "README-内容", sha: leaf },
    ],
  };

  await assertOracleAgreement(root);
}
