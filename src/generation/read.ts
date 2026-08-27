import { Result, panic, type Result as ResultType } from "better-result";
import { decodeObject } from "../git/index.js";
import { assertNever, FILE_MODE } from "../git/types.js";
import type { Commit, GitObject, Sha } from "../git/types.js";
import type { StorageUnavailableError } from "../storage/errors.js";
import type { Store } from "../storage/types.js";
import type { CommitSnapshot, Module } from "./types.js";

export type LoadedGeneration = {
  readonly generation: CommitSnapshot;
  readonly modules: readonly Module[];
};

/** Read a commit and flatten its nested manifest into authored modules. */
export async function readGeneration(
  store: Store,
  sha: Sha,
): Promise<ResultType<LoadedGeneration, StorageUnavailableError>> {
  const commit = await readCommit(store, sha);
  if (Result.isError(commit)) {
    return commit;
  }
  const modules = await readManifest(store, commit.value.tree);
  if (Result.isError(modules)) {
    return modules;
  }
  const generation = {
    sha,
    parent: onlyParent(commit.value),
    manifest: commit.value.tree,
    createdAt: commit.value.committer.timestamp,
    summary: commit.value.message,
  } satisfies CommitSnapshot;
  return Result.ok({ generation, modules: modules.value });
}

async function readManifest(
  store: Store,
  treeSha: Sha,
): Promise<ResultType<readonly Module[], StorageUnavailableError>> {
  const modules: Module[] = [];
  const read = await readTree(store, treeSha, "", modules);
  if (Result.isError(read)) {
    return read;
  }
  return Result.ok(modules);
}

async function readTree(
  store: Store,
  treeSha: Sha,
  parentPath: string,
  modules: Module[],
): Promise<ResultType<void, StorageUnavailableError>> {
  const object = await readObject(store, treeSha, `manifest tree ${treeSha}`);
  if (Result.isError(object)) {
    return object;
  }
  if (object.value.type !== "tree") {
    panic(`manifest tree ${treeSha} is ${object.value.type}, not a tree`);
  }

  for (const entry of object.value.entries) {
    validateManifestName(entry.name, parentPath);
    const path = parentPath.length === 0 ? entry.name : `${parentPath}/${entry.name}`;
    switch (entry.mode) {
      case FILE_MODE.tree: {
        const read = await readTree(store, entry.sha, path, modules);
        if (Result.isError(read)) {
          return read;
        }
        break;
      }
      case FILE_MODE.regular:
      case FILE_MODE.executable: {
        const blob = await readBlob(store, entry.sha, path);
        if (Result.isError(blob)) {
          return blob;
        }
        modules.push({
          path,
          content: blob.value,
          executable: entry.mode === FILE_MODE.executable,
        });
        break;
      }
      case FILE_MODE.symlink:
        return panic(`manifest module ${JSON.stringify(path)} is a symlink`);
      default:
        assertNever(entry.mode, "generation manifest mode");
    }
  }
  return Result.ok();
}

function validateManifestName(name: string, parentPath: string): void {
  if (name === "." || name === "..") {
    const path = parentPath.length === 0 ? name : `${parentPath}/${name}`;
    panic(`manifest contains invalid module path ${JSON.stringify(path)}`);
  }
}

async function readBlob(
  store: Store,
  sha: Sha,
  path: string,
): Promise<ResultType<Uint8Array, StorageUnavailableError>> {
  const object = await readObject(store, sha, `manifest blob for ${JSON.stringify(path)}`);
  if (Result.isError(object)) {
    return object;
  }
  if (object.value.type !== "blob") {
    panic(`manifest blob ${sha} for ${JSON.stringify(path)} is ${object.value.type}, not a blob`);
  }
  return Result.ok(object.value.data.slice());
}

async function readCommit(
  store: Store,
  sha: Sha,
): Promise<ResultType<Commit, StorageUnavailableError>> {
  const object = await readObject(store, sha, `commit ${sha}`);
  if (Result.isError(object)) {
    return object;
  }
  if (object.value.type !== "commit") {
    panic(`commit object ${sha} is ${object.value.type}, not a commit`);
  }
  if (object.value.commit.parents.length > 1) {
    panic(`commit ${sha} has ${object.value.commit.parents.length} parents; expected at most one`);
  }
  return Result.ok(object.value.commit);
}

function onlyParent(commit: Commit): Sha | undefined {
  return commit.parents[0];
}

/** Stored objects missing, malformed, or of an unexpected shape violate store invariants. */
async function readObject(
  store: Store,
  sha: Sha,
  description: string,
): Promise<ResultType<GitObject, StorageUnavailableError>> {
  const read = await store.readObject(sha);
  if (Result.isError(read)) {
    return read;
  }
  if (read.value === undefined) {
    panic(`missing ${description} object ${sha}`);
  }
  const decoded = decodeObject(read.value);
  if (Result.isError(decoded)) {
    panic(`malformed ${description} object ${sha}`, decoded.error);
  }
  return Result.ok(decoded.value);
}
