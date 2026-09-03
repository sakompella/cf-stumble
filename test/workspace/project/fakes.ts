import type {
  BackendExecEvent,
  ExecBackend,
  ExecBackendHandle,
  ExecBackendInput,
  ProjectDirent,
  ProjectFilesystemProvider,
  ProjectStat,
  ProjectTransactions,
} from "../../../src/workspace/project/index.js";
import type { DeferredExec } from "./deferred-exec.js";

class FakeFsError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

type FakeNode =
  | { type: "file"; data: Uint8Array; mtimeMs: number }
  | { type: "dir"; mtimeMs: number }
  | { type: "symlink"; target: string; mtimeMs: number };

interface FdState {
  path: string;
  append: boolean;
}

/**
 * An in-memory stand-in for `@cloudflare/computer`'s `SQLiteWorkspaceProvider`, faithful to the
 * two documented quirks this target works around: a symlink's `lstatSync().size` is the UTF-16
 * length of its target text (not a byte count), and `openSync`/`writeSync` never read a file's
 * existing content to satisfy an append.
 */
export class FakeProjectFilesystemProvider implements ProjectFilesystemProvider {
  readonly nodes = new Map<string, FakeNode>([["/project", { type: "dir", mtimeMs: 0 }]]);
  readonly calls: string[] = [];
  readonly fds = new Map<number, FdState>();
  #nextFd = 3;
  now = 0;

  lstatSync(path: string): ProjectStat {
    this.calls.push(`lstat:${path}`);
    const node = this.nodes.get(path);
    if (node === undefined) throw new FakeFsError("ENOENT", `no such path: ${path}`);
    return this.#stat(node);
  }

  readlinkSync(path: string): string {
    this.calls.push(`readlink:${path}`);
    const node = this.nodes.get(path);
    if (node === undefined || node.type !== "symlink")
      throw new FakeFsError("EINVAL", "not a symlink");
    return node.target;
  }

  mkdirSync(path: string): void {
    this.calls.push(`mkdir:${path}`);
    if (this.nodes.has(path)) throw new FakeFsError("EEXIST", `path exists: ${path}`);
    this.nodes.set(path, { type: "dir", mtimeMs: this.now });
  }

  readdirSync(path: string, _options: { withFileTypes: true }): ProjectDirent[] {
    this.calls.push(`readdir:${path}`);
    const node = this.nodes.get(path);
    if (node === undefined) throw new FakeFsError("ENOENT", `no such path: ${path}`);
    if (node.type !== "dir") throw new FakeFsError("ENOTDIR", `not a directory: ${path}`);
    const prefix = path === "/" ? "/" : `${path}/`;
    const entries: ProjectDirent[] = [];
    for (const [candidate, candidateNode] of this.nodes) {
      if (!candidate.startsWith(prefix) || candidate === path) continue;
      const relative = candidate.slice(prefix.length);
      if (relative.includes("/")) continue;
      entries.push(direntOf(relative, candidateNode));
    }
    return entries;
  }

  openSync(path: string, flags: "w" | "a" | "wx"): number {
    this.calls.push(`open:${path}:${flags}`);
    const existing = this.nodes.get(path);
    if (existing !== undefined) {
      if (flags === "wx") throw new FakeFsError("EEXIST", `path exists: ${path}`);
      if (existing.type === "dir") throw new FakeFsError("EISDIR", `path is a directory: ${path}`);
    }
    if (flags !== "a" || existing === undefined) {
      this.nodes.set(path, { type: "file", data: new Uint8Array(0), mtimeMs: this.now });
    }
    const fd = this.#nextFd++;
    this.fds.set(fd, { path, append: flags === "a" });
    return fd;
  }

  writeSync(fd: number, buffer: Uint8Array): number {
    this.calls.push(`write:${fd}`);
    const state = this.fds.get(fd);
    if (state === undefined) throw new FakeFsError("EBADF", `unknown fd ${fd}`);
    const node = this.nodes.get(state.path);
    if (node === undefined || node.type !== "file")
      throw new FakeFsError("EBADF", "fd is not a file");
    const next = state.append ? concat(node.data, buffer) : buffer.slice();
    this.nodes.set(state.path, { type: "file", data: next, mtimeMs: this.now });
    return buffer.byteLength;
  }

  closeSync(fd: number): void {
    this.calls.push(`close:${fd}`);
    if (!this.fds.delete(fd)) throw new FakeFsError("EBADF", `unknown fd ${fd}`);
  }

  readFileSync(path: string): Uint8Array {
    this.calls.push(`read:${path}`);
    const node = this.nodes.get(path);
    if (node === undefined) throw new FakeFsError("ENOENT", `no such file: ${path}`);
    if (node.type !== "file") throw new FakeFsError("EISDIR", `path is a directory: ${path}`);
    return node.data.slice();
  }

  addDirectory(path: string): void {
    this.nodes.set(path, { type: "dir", mtimeMs: this.now });
  }

  addFile(path: string, data: Uint8Array): void {
    this.nodes.set(path, { type: "file", data, mtimeMs: this.now });
  }

  addSymlink(path: string, target: string): void {
    this.nodes.set(path, { type: "symlink", target, mtimeMs: this.now });
  }

  #stat(node: FakeNode): ProjectStat {
    const size =
      node.type === "file"
        ? node.data.byteLength
        : node.type === "symlink"
          ? node.target.length
          : 0;
    return {
      size,
      mtimeMs: node.mtimeMs,
      isFile: () => node.type === "file",
      isDirectory: () => node.type === "dir",
      isSymbolicLink: () => node.type === "symlink",
    };
  }
}

function direntOf(name: string, node: FakeNode): ProjectDirent {
  return {
    name,
    isFile: () => node.type === "file",
    isDirectory: () => node.type === "dir",
    isSymbolicLink: () => node.type === "symlink",
  };
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const result = new Uint8Array(a.byteLength + b.byteLength);
  result.set(a, 0);
  result.set(b, a.byteLength);
  return result;
}

/** Runs the closure inline. Real transactionality does not matter for a single-threaded fake. */
export class FakeProjectTransactions implements ProjectTransactions {
  calls = 0;
  transactionSync<T>(closure: () => T): T {
    this.calls += 1;
    return closure();
  }
}

type ReadResult = { done: false; value: BackendExecEvent } | { done: true };
type QueueItem =
  | { kind: "event"; event: BackendExecEvent }
  | { kind: "end" }
  | { kind: "error"; error: unknown };
interface Waiter {
  resolve: (result: ReadResult) => void;
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Test fake: simulates whatever error shape a broken backend stream would throw.
  reject: (error: unknown) => void;
}

/**
 * A single exec handle whose events and completion a test drives by hand. `read()` may be called
 * before its outcome is known — a target starts pumping the reader synchronously — so every
 * outcome (an event, EOF, or a failure) is queued or, if a read is already pending, delivered to
 * it directly rather than requiring the test to win a race against the pump loop.
 */
export class ManualExecHandle implements ExecBackendHandle {
  #queue: QueueItem[] = [];
  #waiters: Waiter[] = [];
  #ended = false;
  killCalls = 0;
  killBehavior: () => Promise<void> = () => Promise.resolve();

  readonly reader = {
    read: (): Promise<ReadResult> => {
      const next = this.#queue.shift();
      if (next !== undefined) return this.#settle(next);
      if (this.#ended) return Promise.resolve({ done: true });
      return new Promise((resolve, reject) => {
        this.#waiters.push({ resolve, reject });
      });
    },
    cancel: (): Promise<void> => {
      this.#ended = true;
      return Promise.resolve();
    },
  };

  push(event: BackendExecEvent): void {
    this.#deliver({ kind: "event", event });
  }

  end(): void {
    this.#ended = true;
    this.#deliver({ kind: "end" });
  }

  /** Fails the next (or currently pending) read, the way a broken backend stream would. */
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Test fake: simulates whatever error shape a broken backend stream would throw.
  fail(error: unknown): void {
    this.#ended = true;
    this.#deliver({ kind: "error", error });
  }

  kill(): Promise<void> {
    this.killCalls += 1;
    return this.killBehavior();
  }

  #deliver(item: QueueItem): void {
    const waiter = this.#waiters.shift();
    if (waiter === undefined) {
      this.#queue.push(item);
      return;
    }
    if (item.kind === "error") waiter.reject(item.error);
    else if (item.kind === "end") waiter.resolve({ done: true });
    else waiter.resolve({ done: false, value: item.event });
  }

  #settle(item: QueueItem): Promise<ReadResult> {
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- Test fake: `item.error` is deliberately whatever value `fail()` was given.
    if (item.kind === "error") return Promise.reject(item.error);
    if (item.kind === "end") return Promise.resolve({ done: true });
    return Promise.resolve({ done: false, value: item.event });
  }
}

/**
 * Hands out one `ManualExecHandle` per `exec()` call, recording every request it received. A test
 * that needs to control exactly when handle creation settles calls `deferNextExec` first; the
 * next `exec()` call then returns that deferred's promise instead of resolving immediately.
 */
export class FakeExecBackend implements ExecBackend {
  readonly handles: ManualExecHandle[] = [];
  readonly requests: ExecBackendInput[] = [];
  onExec: ((input: ExecBackendInput) => void) | undefined;
  readonly #deferredQueue: Promise<ExecBackendHandle>[] = [];

  /** The next call to `exec()` returns `deferred.promise` instead of resolving immediately. */
  deferNextExec(deferred: DeferredExec): void {
    this.#deferredQueue.push(deferred.promise);
  }

  exec(input: ExecBackendInput): Promise<ExecBackendHandle> {
    this.requests.push(input);
    this.onExec?.(input);
    const deferred = this.#deferredQueue.shift();
    if (deferred !== undefined) return deferred;
    const handle = new ManualExecHandle();
    this.handles.push(handle);
    return Promise.resolve(handle);
  }
}
