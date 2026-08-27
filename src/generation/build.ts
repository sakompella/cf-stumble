import { panic, Result, type Result as ResultType } from "better-result";
import { encodeObject } from "../git/index.js";
import { FILE_MODE } from "../git/types.js";
import type { Sha, Signature, TreeEntry } from "../git/types.js";
import type { ObjectTooLargeError, Store } from "../storage/types.js";
import { InvalidGenerationInputError } from "./errors.js";
import {
  makeGenerationCommitter,
  validateBuildGenerationOptions,
  validateGenerationModulePath,
  type CommitSnapshot,
  type Module,
} from "./types.js";

export type BuildGenerationOptions = {
  readonly modules: readonly Module[];
  readonly parent: CommitSnapshot | undefined;
  readonly author: Signature;
  readonly committer?: Signature;
  readonly createdAt: number;
  readonly summary: string;
};

export type GenerationBuildError = InvalidGenerationInputError | ObjectTooLargeError;

type ModuleEntry = {
  readonly module: Module;
  blob: Sha | undefined;
};

type TreeNode = {
  readonly files: Map<string, ModuleEntry>;
  readonly trees: Map<string, TreeNode>;
};

/** Build and store a generation whose manifest mirrors module paths as nested git trees. */
export async function buildGeneration(
  store: Store,
  options: BuildGenerationOptions,
): Promise<ResultType<CommitSnapshot, GenerationBuildError>> {
  const validated = validateBuildGenerationOptions(options);
  if (Result.isError(validated)) {
    return validated;
  }
  const root = createTreeNode();

  for (const module of options.modules) {
    const inserted = insertModule(root, module);
    if (Result.isError(inserted)) {
      return inserted;
    }
  }
  for (const module of options.modules) {
    const written = await writeObject(store, encodeObject({ type: "blob", data: module.content }));
    if (Result.isError(written)) {
      return written;
    }
    findModuleEntry(root, module.path).blob = written.value;
  }

  const manifest = await writeTree(store, root);
  if (Result.isError(manifest)) {
    return manifest;
  }
  const summary = normalizeCommitMessage(options.summary);
  const sha = await writeCommit(store, options, manifest.value, summary);
  if (Result.isError(sha)) {
    return sha;
  }
  return Result.ok({
    sha: sha.value,
    parent: options.parent?.sha,
    manifest: manifest.value,
    createdAt: options.createdAt,
    summary,
  });
}

function writeCommit(
  store: Store,
  options: BuildGenerationOptions,
  manifest: Sha,
  summary: string,
): Promise<ResultType<Sha, ObjectTooLargeError>> {
  return writeObject(
    store,
    encodeObject({
      type: "commit",
      commit: {
        tree: manifest,
        parents: options.parent === undefined ? [] : [options.parent.sha],
        author: options.author,
        committer: makeGenerationCommitter(options),
        message: summary,
      },
    }),
  );
}

function createTreeNode(): TreeNode {
  return { files: new Map(), trees: new Map() };
}

function insertModule(
  root: TreeNode,
  module: Module,
): ResultType<null, InvalidGenerationInputError> {
  const parts = validateGenerationModulePath(module.path);
  if (Result.isError(parts)) {
    return parts;
  }
  let node = root;
  for (const part of parts.value.slice(0, -1)) {
    if (node.files.has(part)) {
      return invalidInput(
        "module-path-conflict",
        `module path conflicts with a file: ${module.path}`,
      );
    }
    node = node.trees.get(part) ?? createChild(node, part);
  }

  const name = parts.value.at(-1);
  if (name === undefined) {
    panic("validated module path has no file name");
  }
  if (node.files.has(name) || node.trees.has(name)) {
    return invalidInput("duplicate-module-path", `duplicate module path ${module.path}`);
  }
  node.files.set(name, { module, blob: undefined });
  return Result.ok(null);
}

function createChild(parent: TreeNode, name: string): TreeNode {
  const child = createTreeNode();
  parent.trees.set(name, child);
  return child;
}

function findModuleEntry(root: TreeNode, path: string): ModuleEntry {
  const parts = validateGenerationModulePath(path).unwrap(
    `inserted module path became invalid: ${JSON.stringify(path)}`,
  );
  let node = root;
  for (const part of parts.slice(0, -1)) {
    const child = node.trees.get(part);
    if (child === undefined) {
      return panic(`inserted module path disappeared: ${JSON.stringify(path)}`);
    }
    node = child;
  }
  const name = parts.at(-1);
  if (name === undefined) {
    return panic("validated module path has no file name");
  }
  const entry = node.files.get(name);
  if (entry === undefined) {
    return panic(`inserted module path disappeared: ${JSON.stringify(path)}`);
  }
  return entry;
}

async function writeTree(
  store: Store,
  node: TreeNode,
): Promise<ResultType<Sha, ObjectTooLargeError>> {
  const entries: TreeEntry[] = [];
  for (const [name, child] of node.trees) {
    const sha = await writeTree(store, child);
    if (Result.isError(sha)) {
      return sha;
    }
    entries.push({ mode: FILE_MODE.tree, name, sha: sha.value });
  }
  for (const [name, entry] of node.files) {
    if (entry.blob === undefined) {
      return panic(`module blob was not written: ${name}`);
    }
    entries.push({
      mode: entry.module.executable ? FILE_MODE.executable : FILE_MODE.regular,
      name,
      sha: entry.blob,
    });
  }
  return writeObject(store, encodeObject({ type: "tree", entries }));
}

function writeObject(
  store: Store,
  bytes: Uint8Array,
): Promise<ResultType<Sha, ObjectTooLargeError>> {
  return store.writeObject(bytes);
}

function normalizeCommitMessage(summary: string): string {
  return `${summary.replace(/\n+$/u, "")}\n`;
}

function invalidInput(
  condition: InvalidGenerationInputError["condition"],
  detail: string,
): ResultType<never, InvalidGenerationInputError> {
  return Result.err(new InvalidGenerationInputError({ condition, detail }));
}
