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
import { expect } from "vitest";

import {
  decodeObject,
  encodeObject,
  FILE_MODE,
  hashObject,
  parseSha,
} from "../../src/git/index.js";
import type { Commit, GitObject, Sha, TreeEntry } from "../../src/git/index.js";
import { createMemoryFs } from "./memory-fs.js";
import { expectOk } from "./result.js";

/**
 * isomorphic-git as an independent oracle for `src/git/` (ADR-0011): a second implementation
 * written by other people, so agreement is evidence rather than our decoder agreeing with our
 * encoder. Shared by `git/oracle.test.ts`, which pins hand-chosen shapes in workerd, and by
 * `git/oracle.props.test.ts`, which runs the same comparison over generated objects in Node.
 */

const gitdir = "/oracle/.git";

function createOracleFs(): FsClient {
  return createMemoryFs();
}

/**
 * Encode `object` both ways and check every direction agrees: same object id, same bytes, our
 * decoder reads the oracle's bytes, and the oracle reads ours. Returns the agreed object id so
 * callers can build nested objects out of it.
 */
export async function assertOracleAgreement(object: GitObject): Promise<Sha> {
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
  expect(new Uint8Array(writtenByOracle.object)).toEqual(encoded);
  expect(expectOk(decodeObject(new Uint8Array(writtenByOracle.object)))).toEqual(
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

async function assertReadableByOracle(fs: FsClient, oid: string, object: GitObject): Promise<void> {
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

/**
 * isomorphic-git counts a timezone offset the other way round from us, so the sign flips. Negating
 * zero in JavaScript gives `-0`, and isomorphic-git goes out of its way to preserve that: it writes
 * `-0000`, git's "timezone unknown" marker, where we write `+0000`. `|| 0` keeps a UTC commit from
 * turning into a differently-signed one on the way to the oracle.
 */
function negateOffset(minutes: number): number {
  return -minutes || 0;
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
      timezoneOffset: negateOffset(commit.author.timezoneOffsetMinutes),
    },
    committer: {
      name: commit.committer.name,
      email: commit.committer.email,
      timestamp: commit.committer.timestamp,
      timezoneOffset: negateOffset(commit.committer.timezoneOffsetMinutes),
    },
  };
}

/** What `decodeObject` must return: identical, except that a tree comes back in git's order. */
export function canonicalObject(object: GitObject): GitObject {
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
