import { Result, panic } from "better-result";
import { decodeObject } from "../git/index.js";
import { assertNever, FILE_MODE } from "../git/types.js";
import type { Commit, GitObject, Sha } from "../git/types.js";
import type { Store } from "../storage/types.js";
import type { CommitSnapshot, Module } from "./types.js";

export type LoadedGeneration = {
  readonly generation: CommitSnapshot;
  readonly modules: readonly Module[];
};

/** Read a commit and flatten its nested manifest into authored modules. */
export async function readGeneration(store: Store, sha: Sha): Promise<LoadedGeneration> {
  const commit = await readCommit(store, sha);
  const modules = await readManifest(store, commit.tree);
  const generation = {
    sha,
    parent: onlyParent(commit),
    manifest: commit.tree,
    createdAt: commit.committer.timestamp,
    summary: commit.message,
  } satisfies CommitSnapshot;
  return { generation, modules };
}

async function readManifest(store: Store, treeSha: Sha): Promise<readonly Module[]> {
  const modules: Module[] = [];
  await readTree(store, treeSha, "", modules);
  return modules;
}

async function readTree(
  store: Store,
  treeSha: Sha,
  parentPath: string,
  modules: Module[],
): Promise<void> {
  const object = await readObject(store, treeSha, `manifest tree ${treeSha}`);
  if (object.type !== "tree") {
    throw new Error(`manifest tree ${treeSha} is ${object.type}, not a tree`);
  }

  for (const entry of object.entries) {
    validateManifestName(entry.name, parentPath);
    const path = parentPath.length === 0 ? entry.name : `${parentPath}/${entry.name}`;
    switch (entry.mode) {
      case FILE_MODE.tree:
        await readTree(store, entry.sha, path, modules);
        break;
      case FILE_MODE.regular:
      case FILE_MODE.executable:
        modules.push({
          path,
          content: await readBlob(store, entry.sha, path),
          executable: entry.mode === FILE_MODE.executable,
        });
        break;
      case FILE_MODE.symlink:
        throw new Error(`manifest module ${JSON.stringify(path)} is a symlink`);
      default:
        assertNever(entry.mode, "generation manifest mode");
    }
  }
}

function validateManifestName(name: string, parentPath: string): void {
  if (name === "." || name === "..") {
    const path = parentPath.length === 0 ? name : `${parentPath}/${name}`;
    throw new Error(`manifest contains invalid module path ${JSON.stringify(path)}`);
  }
}

async function readBlob(store: Store, sha: Sha, path: string): Promise<Uint8Array> {
  const object = await readObject(store, sha, `manifest blob for ${JSON.stringify(path)}`);
  if (object.type !== "blob") {
    throw new Error(
      `manifest blob ${sha} for ${JSON.stringify(path)} is ${object.type}, not a blob`,
    );
  }
  return object.data.slice();
}

async function readCommit(store: Store, sha: Sha): Promise<Commit> {
  const object = await readObject(store, sha, `commit ${sha}`);
  if (object.type !== "commit") {
    throw new Error(`commit object ${sha} is ${object.type}, not a commit`);
  }
  if (object.commit.parents.length > 1) {
    throw new Error(
      `commit ${sha} has ${object.commit.parents.length} parents; expected at most one`,
    );
  }
  return object.commit;
}

function onlyParent(commit: Commit): Sha | undefined {
  return commit.parents[0];
}

/**
 * The seam between `src/git/`, which now carries decode failures in a `Result`, and the rest of
 * `src/generation/`, which still throws. Slice 6 migrates this module; until then the `Result`
 * stops here rather than half-propagating.
 *
 * A malformed object is a `panic` because of where the bytes came from: `sha` addresses content
 * this supervisor hashed and wrote itself, so bytes that will not decode mean the store lost or
 * corrupted them, or the encoder is wrong. Neither is a condition a caller can report and carry
 * on from, and neither is the requester's doing — it stays a 500 either way, which is the
 * disposition the adoption plan records for F18. A missing object keeps throwing, because that one
 * is ordinary: an object can be absent because a generation was never fully written, and callers
 * do surface it.
 */
async function readObject(store: Store, sha: Sha, description: string): Promise<GitObject> {
  const bytes = await store.readObject(sha);
  if (bytes === undefined) {
    throw new Error(`missing ${description} object ${sha}`);
  }
  const decoded = decodeObject(bytes);
  if (Result.isError(decoded)) {
    panic(`malformed ${description} object ${sha}`, decoded.error);
  }
  return decoded.value;
}
