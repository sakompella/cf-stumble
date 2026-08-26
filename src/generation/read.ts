import { decodeObject } from "../git/index.js";
import { assertNever, FILE_MODE } from "../git/types.js";
import type { Commit, GitObject, Sha } from "../git/types.js";
import type { Store } from "../storage/types.js";
import { parseGenerationNumber } from "./types.js";
import type { Generation, Module } from "./types.js";

export type LoadedGeneration = {
  readonly generation: Generation;
  readonly modules: readonly Module[];
};

/** Read a commit generation and flatten its nested manifest into authored modules. */
export async function readGeneration(
  store: Store,
  sha: Sha,
): Promise<LoadedGeneration> {
  const commit = await readCommit(store, sha);
  const modules = await readManifest(store, commit.tree);
  const number = await generationNumber(store, sha);
  const generation = {
    sha,
    number,
    parent: onlyParent(commit),
    manifest: commit.tree,
    createdAt: commit.committer.timestamp,
    summary: commit.message,
  } satisfies Generation;
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
  const object = await readObject(store, sha, `generation commit ${sha}`);
  if (object.type !== "commit") {
    throw new Error(`generation object ${sha} is ${object.type}, not a commit`);
  }
  if (object.commit.parents.length > 1) {
    throw new Error(
      `generation commit ${sha} has ${object.commit.parents.length} parents; expected at most one`,
    );
  }
  return object.commit;
}

function onlyParent(commit: Commit): Sha | undefined {
  return commit.parents[0];
}

async function generationNumber(store: Store, start: Sha) {
  const visited = new Set<Sha>();
  let current = start;
  let depth = 0;

  while (true) {
    if (visited.has(current)) {
      throw new Error(`generation lineage cycle detected at ${current}`);
    }
    visited.add(current);

    const commit = await readCommit(store, current);
    const parent = onlyParent(commit);
    if (parent === undefined) {
      return parseGenerationNumber(depth);
    }
    depth += 1;
    current = parent;
  }
}

async function readObject(
  store: Store,
  sha: Sha,
  description: string,
): Promise<GitObject> {
  const bytes = await store.readObject(sha);
  if (bytes === undefined) {
    throw new Error(`missing ${description} object ${sha}`);
  }
  try {
    return decodeObject(bytes);
  } catch (error: unknown) {
    throw new Error(`malformed ${description} object ${sha}`, { cause: error });
  }
}
