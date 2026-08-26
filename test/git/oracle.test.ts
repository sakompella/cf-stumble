import {
  readBlob,
  readCommit,
  readObject,
  readTree,
  writeBlob,
  writeCommit,
  writeObject,
  writeTree,
  type CommitObject,
  type FsClient,
  type TreeEntry as OracleTreeEntry,
} from "isomorphic-git";
import { describe, expect, it } from "vitest";

import {
  decodeObject,
  encodeObject,
  FILE_MODE,
  hashObject,
  parseSha,
} from "../../src/git/index.js";
import type { Commit, GitObject, Sha, TreeEntry } from "../../src/git/index.js";
import { createMemoryFs } from "../support/memory-fs.js";

const gitdir = "/oracle/.git";

function createOracleFs(): FsClient {
  // MemoryFs uses a deliberately narrow runtime shape whose method record is typed loosely
  // because isomorphic-git's FsClient declarations use Function for every method. This is the
  // single boundary cast from the shared runtime shim to isomorphic-git's loose declaration.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return createMemoryFs() as unknown as FsClient;
}

describe("isomorphic-git codec oracle", () => {
  it("agrees on blob hashes and reads blobs in both directions", async () => {
    const cases = [
      new Uint8Array(),
      Uint8Array.from([0, 1, 2, 255, 0]),
    ];

    for (const data of cases) {
      await assertOracleAgreement({ type: "blob", data });
    }
  });

  it("agrees on nested tree hashes and exercises directory sorting", async () => {
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
  });
});

async function assertOracleAgreement(object: GitObject): Promise<Sha> {
  const encoded = encodeObject(object);
  const oracleFs = createOracleFs();
  const oracleOid = await writeWithOracle(oracleFs, object);
  await expect(hashObject(encoded)).resolves.toBe(oracleOid);

  // The wrapped form is the only isomorphic-git API that exposes the exact bytes needed by our
  // decoder, so this deprecated general-purpose API is intentional here.
  // oxlint-disable-next-line typescript/no-deprecated
  const writtenByOracle = await readObject({
    fs: oracleFs,
    gitdir,
    oid: oracleOid,
    format: "wrapped",
  });
  if (writtenByOracle.type !== "wrapped") {
    throw new Error(`expected a wrapped object, got ${writtenByOracle.type}`);
  }
  expect(decodeObject(new Uint8Array(writtenByOracle.object))).toEqual(
    canonicalObject(object),
  );

  const encodedFs = createOracleFs();
  // The wrapped form is the only isomorphic-git API that accepts our exact encoded bytes.
  // oxlint-disable-next-line typescript/no-deprecated
  const encodedOid = await writeObject({
    fs: encodedFs,
    gitdir,
    object: encoded,
    format: "wrapped",
  });
  expect(encodedOid).toBe(oracleOid);
  await assertReadableByOracle(encodedFs, encodedOid, object);

  return parseSha(oracleOid);
}

function writeWithOracle(fs: FsClient, object: GitObject): Promise<string> {
  switch (object.type) {
    case "blob":
      return writeBlob({ fs, gitdir, blob: object.data });
    case "tree":
      return writeTree({ fs, gitdir, tree: toOracleTree(object.entries) });
    case "commit":
      return writeCommit({ fs, gitdir, commit: toOracleCommit(object.commit) });
    default:
      throw new Error("unsupported git object");
  }
}

async function assertReadableByOracle(
  fs: FsClient,
  oid: string,
  object: GitObject,
): Promise<void> {
  switch (object.type) {
    case "blob": {
      const result = await readBlob({ fs, gitdir, oid });
      expect({ oid: result.oid, blob: new Uint8Array(result.blob) }).toEqual({
        oid,
        blob: object.data,
      });
      break;
    }
    case "tree": {
      const result = await readTree({ fs, gitdir, oid });
      expect({ oid: result.oid, tree: result.tree }).toEqual({
        oid,
        tree: sortOracleReadEntries(toOracleTree(object.entries)),
      });
      break;
    }
    case "commit": {
      const result = await readCommit({ fs, gitdir, oid });
      expect({ oid: result.oid, commit: result.commit }).toEqual({
        oid,
        commit: toOracleCommit(object.commit),
      });
      break;
    }
    default:
      throw new Error("unsupported git object");
  }
}

function toOracleTree(entries: readonly TreeEntry[]): OracleTreeEntry[] {
  return entries.map((entry) => ({
    mode: entry.mode === FILE_MODE.tree ? "040000" : entry.mode,
    path: entry.name,
    oid: entry.sha,
    type: entry.mode === FILE_MODE.tree ? "tree" : "blob",
  }));
}

function toOracleCommit(commit: Commit): CommitObject {
  return {
    message: commit.message,
    tree: commit.tree,
    parent: [...commit.parents],
    author: {
      name: commit.author.name,
      email: commit.author.email,
      timestamp: commit.author.timestamp,
      timezoneOffset: commit.author.timezoneOffsetMinutes,
    },
    committer: {
      name: commit.committer.name,
      email: commit.committer.email,
      timestamp: commit.committer.timestamp,
      timezoneOffset: commit.committer.timezoneOffsetMinutes,
    },
  };
}

function canonicalObject(object: GitObject): GitObject {
  if (object.type !== "tree") {
    return object;
  }
  return {
    type: "tree",
    entries: object.entries.toSorted(compareGitTreeEntries),
  };
}

function compareGitTreeEntries(left: TreeEntry, right: TreeEntry): number {
  return compareBytes(treeSortKey(left), treeSortKey(right));
}

function treeSortKey(entry: TreeEntry): Uint8Array {
  const name = new TextEncoder().encode(entry.name);
  if (entry.mode !== FILE_MODE.tree) {
    return name;
  }
  const key = new Uint8Array(name.byteLength + 1);
  key.set(name);
  key[name.byteLength] = 47;
  return key;
}

function sortOracleReadEntries(entries: readonly OracleTreeEntry[]): OracleTreeEntry[] {
  return entries.toSorted((left, right) => {
    if (left.path < right.path) return -1;
    if (left.path > right.path) return 1;
    return 0;
  });
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const length = Math.min(left.byteLength, right.byteLength);
  for (let index = 0; index < length; index += 1) {
    const leftByte = left[index];
    const rightByte = right[index];
    if (leftByte === undefined || rightByte === undefined) {
      throw new Error("missing tree sort byte");
    }
    if (leftByte !== rightByte) return leftByte - rightByte;
  }
  return left.byteLength - right.byteLength;
}
