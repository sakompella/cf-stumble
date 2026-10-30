import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import {
  FileError,
  type FileWatcher,
  type Result,
  type WatchChange,
  type WatchTarget,
} from "@earendil-works/pi-durable/env";
import { listDirectory, open, statFollowing } from "./execution-env-files.js";
import { childOf, type ComputerWorkspace, type WorkspacePath } from "./execution-env-paths.js";

/**
 * Computer reports no file events to a capability holder, so the watcher compares snapshots:
 * each path's kind, size, and modification time. Pi Durable's conformance cases change a file's
 * size at every step, which a snapshot always sees.
 */
const POLL_INTERVAL_MS = 500;

/** Each directory costs one capability call per poll, so a watched tree stays small. */
const MAX_WATCHED_ENTRIES = 5_000;

type Snapshot = Map<string, string>;

function signatureOf(info: { kind: string; size: number; mtimeMs: number }): string {
  return info.kind === "directory" ? "directory" : `${info.kind}:${info.size}:${info.mtimeMs}`;
}

function excluded(target: WatchTarget, name: string): boolean {
  return (
    (target.exclude?.hidden === true && name.startsWith(".")) ||
    (target.exclude?.names?.includes(name) ?? false)
  );
}

function tooLarge(path: string): Result<never, FileError> {
  return {
    ok: false,
    error: new FileError("unknown", "the watched tree is too large to poll", path),
  };
}

async function addDirectory(
  workspace: ComputerWorkspace,
  target: WatchTarget,
  directory: WorkspacePath,
  snapshot: Snapshot,
): Promise<Result<void, FileError>> {
  const listed = await listDirectory(workspace, directory);

  if (!listed.ok)
    return listed.error.code === "not_found" ? { ok: true, value: undefined } : listed;

  for (const entry of listed.value) {
    if (excluded(target, entry.name)) continue;

    snapshot.set(entry.path, signatureOf(entry));

    if (snapshot.size > MAX_WATCHED_ENTRIES) return tooLarge(directory.absolute);

    if (target.recursive === true && entry.kind === "directory") {
      const added = await addDirectory(workspace, target, childOf(directory, entry.name), snapshot);

      if (!added.ok) return added;
    }
  }

  return { ok: true, value: undefined };
}

/** A missing target, or one below a file, is simply absent from the snapshot. */
async function addTarget(
  workspace: ComputerWorkspace,
  target: WatchTarget,
  snapshot: Snapshot,
): Promise<Result<void, FileError>> {
  const opened = open(workspace, target.path, BACKGROUND_CONTEXT);

  if (!opened.ok) return opened;

  const stat = await statFollowing(workspace, opened.value);

  if (!stat.ok) {
    const absent = stat.error.code === "not_found" || stat.error.code === "not_directory";

    return absent ? { ok: true, value: undefined } : stat;
  }

  snapshot.set(opened.value.absolute, signatureOf(stat.value.info));

  if (stat.value.info.kind !== "directory") return { ok: true, value: undefined };

  return addDirectory(workspace, target, opened.value, snapshot);
}

async function snapshotOf(
  workspace: ComputerWorkspace,
  targets: readonly WatchTarget[],
): Promise<Result<Snapshot, FileError>> {
  const snapshot: Snapshot = new Map();

  for (const target of targets) {
    const added = await addTarget(workspace, target, snapshot);

    if (!added.ok) return added;
  }

  return { ok: true, value: snapshot };
}

function parentOf(path: string): string {
  return path.slice(0, path.lastIndexOf("/"));
}

/** An entry that appears or disappears also changes its watched directory's listing. */
function changedPaths(before: Snapshot, after: Snapshot): string[] {
  const changed = new Set<string>();

  for (const path of new Set([...before.keys(), ...after.keys()])) {
    if (before.get(path) === after.get(path)) continue;

    changed.add(path);

    const parent = parentOf(path);

    const appearedOrVanished = !before.has(path) || !after.has(path);

    if (appearedOrVanished && before.has(parent) && after.has(parent)) changed.add(parent);
  }

  return [...changed].toSorted();
}

class PollingWatcher implements FileWatcher {
  readonly mode = "polling";
  readonly #workspace: ComputerWorkspace;
  readonly #targets: readonly WatchTarget[];
  readonly #onChange: (change: WatchChange) => void;
  #snapshot: Snapshot;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #closed = false;

  constructor(
    workspace: ComputerWorkspace,
    targets: readonly WatchTarget[],
    onChange: (change: WatchChange) => void,
    snapshot: Snapshot,
  ) {
    this.#workspace = workspace;
    this.#targets = targets;
    this.#onChange = onChange;
    this.#snapshot = snapshot;
    this.#schedule();
  }

  close(_context: Context): Promise<void> {
    this.#closed = true;
    clearTimeout(this.#timer);

    return Promise.resolve();
  }

  #schedule(): void {
    this.#timer = setTimeout(() => void this.#poll(), POLL_INTERVAL_MS);
  }

  async #poll(): Promise<void> {
    const next = await snapshotOf(this.#workspace, this.#targets);

    if (this.#closed) return;

    if (!next.ok) {
      this.#closed = true;
      this.#onChange({ error: next.error });

      return;
    }

    const paths = changedPaths(this.#snapshot, next.value);
    this.#snapshot = next.value;

    if (paths.length > 0) this.#onChange({ paths });

    this.#schedule();
  }
}

export async function watch(
  workspace: ComputerWorkspace,
  targets: readonly WatchTarget[],
  onChange: (change: WatchChange) => void,
  context: Context,
): Promise<Result<FileWatcher, FileError>> {
  if (context.abortSignal?.aborted === true) {
    return { ok: false, error: new FileError("aborted", "aborted") };
  }

  const snapshot = await snapshotOf(workspace, targets);

  if (!snapshot.ok) return snapshot;

  return { ok: true, value: new PollingWatcher(workspace, targets, onChange, snapshot.value) };
}
