import { encodeObject } from "../git/index.js";
import { FILE_MODE } from "../git/types.js";
import type { Signature, Sha, TreeEntry } from "../git/types.js";
import type { Store } from "../storage/types.js";
import { GENESIS_NUMBER, parseGenerationNumber } from "./types.js";
import type { Generation, Module } from "./types.js";

export type BuildGenerationOptions = {
  readonly modules: readonly Module[];
  readonly parent: Generation | undefined;
  readonly author: Signature;
  readonly committer?: Signature;
  readonly createdAt: number;
  readonly summary: string;
};

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
): Promise<Generation> {
  validateOptions(options);
  const root = createTreeNode();

  for (const module of options.modules) {
    insertModule(root, module);
  }

  for (const module of options.modules) {
    const blob = await store.writeObject(
      encodeObject({ type: "blob", data: module.content }),
    );
    findModuleEntry(root, module.path).blob = blob;
  }

  const manifest = await writeTree(store, root);
  const parent = options.parent;
  const number =
    parent === undefined
      ? GENESIS_NUMBER
      : parseGenerationNumber(parent.number + 1);
  const sha = await store.writeObject(
    encodeObject({
      type: "commit",
      commit: {
        tree: manifest,
        parents: parent === undefined ? [] : [parent.sha],
        author: options.author,
        committer: options.committer ?? options.author,
        message: options.summary,
      },
    }),
  );

  return {
    sha,
    number,
    parent: parent?.sha,
    manifest,
    createdAt: options.createdAt,
    summary: options.summary,
  };
}

function createTreeNode(): TreeNode {
  return { files: new Map(), trees: new Map() };
}

function insertModule(root: TreeNode, module: Module): void {
  const parts = validateModulePath(module.path);
  let node = root;

  for (const part of parts.slice(0, -1)) {
    if (node.files.has(part)) {
      throw new TypeError(
        `module path conflicts with a file: ${JSON.stringify(module.path)}`,
      );
    }
    let child = node.trees.get(part);
    if (child === undefined) {
      child = createTreeNode();
      node.trees.set(part, child);
    }
    node = child;
  }

  const name = parts.at(-1);
  if (name === undefined) {
    throw new Error("internal error: validated module path has no file name");
  }
  if (node.files.has(name) || node.trees.has(name)) {
    throw new TypeError(`duplicate module path ${JSON.stringify(module.path)}`);
  }
  node.files.set(name, { module, blob: undefined });
}

function findModuleEntry(root: TreeNode, path: string): ModuleEntry {
  const parts = validateModulePath(path);
  let node = root;
  for (const part of parts.slice(0, -1)) {
    const child = node.trees.get(part);
    if (child === undefined) {
      throw new Error(`internal error: module path disappeared ${JSON.stringify(path)}`);
    }
    node = child;
  }
  const name = parts.at(-1);
  if (name === undefined) {
    throw new Error("internal error: validated module path has no file name");
  }
  const entry = node.files.get(name);
  if (entry === undefined) {
    throw new Error(`internal error: module path disappeared ${JSON.stringify(path)}`);
  }
  return entry;
}

async function writeTree(store: Store, node: TreeNode): Promise<Sha> {
  const entries: TreeEntry[] = [];
  for (const [name, child] of node.trees) {
    entries.push({ mode: FILE_MODE.tree, name, sha: await writeTree(store, child) });
  }
  for (const [name, entry] of node.files) {
    if (entry.blob === undefined) {
      throw new Error(`internal error: module blob was not written ${name}`);
    }
    entries.push({
      mode: entry.module.executable ? FILE_MODE.executable : FILE_MODE.regular,
      name,
      sha: entry.blob,
    });
  }
  return store.writeObject(encodeObject({ type: "tree", entries }));
}

function validateOptions(options: BuildGenerationOptions): void {
  if (!Number.isSafeInteger(options.createdAt)) {
    throw new TypeError("generation createdAt must be a safe integer");
  }
  if (typeof options.summary !== "string") {
    throw new TypeError("generation summary must be a string");
  }
  if (options.committer !== undefined && typeof options.committer !== "object") {
    throw new TypeError("generation committer must be a signature");
  }
  for (const module of options.modules) {
    if (typeof module.path !== "string") {
      throw new TypeError("module path must be a string");
    }
    if (!(module.content instanceof Uint8Array)) {
      throw new TypeError(`module content must be bytes for ${JSON.stringify(module.path)}`);
    }
    if (typeof module.executable !== "boolean") {
      throw new TypeError(
        `module executable flag must be boolean for ${JSON.stringify(module.path)}`,
      );
    }
    validateModulePath(module.path);
  }
}

function validateModulePath(path: string): readonly string[] {
  if (path.length === 0) {
    throw new TypeError("module path must not be empty");
  }
  if (path.startsWith("/")) {
    throw new TypeError(`module path must be relative: ${JSON.stringify(path)}`);
  }
  if (path.includes("\0")) {
    throw new TypeError(`module path must not contain NUL: ${JSON.stringify(path)}`);
  }

  const parts = path.split("/");
  for (const part of parts) {
    if (part.length === 0) {
      throw new TypeError(`module path contains an empty segment: ${JSON.stringify(path)}`);
    }
    if (part === "..") {
      throw new TypeError(`module path must not contain '..': ${JSON.stringify(path)}`);
    }
    if (part === ".") {
      throw new TypeError(`module path must not contain '.': ${JSON.stringify(path)}`);
    }
  }
  return parts;
}
