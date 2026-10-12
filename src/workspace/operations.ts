import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

export type WorkspacePathKind = "file" | "directory" | "symbolic-link";

/**
 * The only imperative operations the Workspace Host needs from Computer, in Computer's own
 * Promise form. `workspaceEffects` is the one place their rejections are classified.
 *
 * `runCommand` takes an optional `stdin` because a secret belongs on standard input and nowhere
 * else: a command line is visible in a process list, and a file has to be created, read, and
 * removed on a filesystem that may not be the one the command runs on. Standard input reaches the
 * process directly, so nothing has to be cleaned up afterwards.
 */
export type WorkspaceOperations = Readonly<{
  lstat(path: string): Promise<WorkspacePathKind | undefined>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  runCommand(
    source: string,
    cwd: string,
    timeoutMs: number,
    stdin?: string,
  ): Promise<Readonly<CommandOutput>>;
}>;

export type CommandOutput = Readonly<{ stdout: string; stderr: string; exitCode: number }>;

/**
 * Thrown by `runCommand` when the command ran but its container changes are not proven to be in
 * the durable workspace store. Only surfaces that need a durable result ask for that check. It
 * carries a tag, so the same value is the typed failure once `workspaceEffects` has caught it.
 */
export class WorkspaceSyncIncomplete extends Error {
  override readonly name = "WorkspaceSyncIncomplete";
  readonly _tag = "WorkspaceSyncIncomplete";
}

/** Computer, its container, or the store rejected an operation. `cause` is what it threw. */
export class WorkspaceUnavailable extends Data.TaggedError("WorkspaceUnavailable")<{
  readonly cause: unknown;
}> {}

export type WorkspaceFault = WorkspaceUnavailable | WorkspaceSyncIncomplete;

/** The operations as Effects. Each rejection becomes one typed fault, and nothing else changes. */
export type WorkspaceEffects = Readonly<{
  lstat(path: string): Effect.Effect<WorkspacePathKind | undefined, WorkspaceFault>;
  readFile(path: string): Effect.Effect<string, WorkspaceFault>;
  writeFile(path: string, content: string): Effect.Effect<void, WorkspaceFault>;
  runCommand(
    source: string,
    cwd: string,
    timeoutMs: number,
    stdin?: string,
  ): Effect.Effect<CommandOutput, WorkspaceFault>;
}>;

function workspaceFault(cause: unknown): WorkspaceFault {
  return cause instanceof WorkspaceSyncIncomplete ? cause : new WorkspaceUnavailable({ cause });
}

/** One native operation as an Effect, its rejection classified as a fault. */
export function attemptWorkspace<A>(operation: () => Promise<A>): Effect.Effect<A, WorkspaceFault> {
  return Effect.tryPromise({ try: operation, catch: workspaceFault });
}

export function workspaceEffects(operations: WorkspaceOperations): WorkspaceEffects {
  return {
    lstat: (path) => attemptWorkspace(() => operations.lstat(path)),
    readFile: (path) => attemptWorkspace(() => operations.readFile(path)),
    writeFile: (path, content) => attemptWorkspace(() => operations.writeFile(path, content)),
    runCommand: (source, cwd, timeoutMs, stdin) =>
      attemptWorkspace(() => operations.runCommand(source, cwd, timeoutMs, stdin)),
  };
}

/** What a fault's operation threw, so a log names the original cause. */
// oxlint-disable-next-line anti-slop/no-unknown-returns -- The value is only ever logged redacted, never parsed.
export function thrownBy(fault: WorkspaceFault): unknown {
  return fault instanceof WorkspaceUnavailable ? fault.cause : fault;
}

/**
 * Answer every failure of a surface's work with a plain value: a typed fault by what its operation
 * threw, and a defect by the value thrown. A surface answers both with its generic code and logs
 * the cause redacted, so a programming fault is never serialized to a caller (ADR-0045).
 */
export function answerFailures<A>(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- A thrown value can be anything; the answer only logs it redacted.
  answer: (thrown: unknown) => A,
): (work: Effect.Effect<A, WorkspaceFault>) => Effect.Effect<A> {
  return (work) =>
    work.pipe(
      Effect.catch((fault) => Effect.sync(() => answer(thrownBy(fault)))),
      Effect.catchDefect((defect) => Effect.sync(() => answer(defect))),
    );
}
