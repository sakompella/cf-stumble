import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

export type WorkspacePathKind = "file" | "directory" | "symbolic-link";

/**
 * `runCommand` takes `stdin` because a secret belongs on standard input: a command line shows in a
 * process list, and a file needs cleanup.
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

export class WorkspaceSyncIncomplete extends Error {
  override readonly name = "WorkspaceSyncIncomplete";
  readonly _tag = "WorkspaceSyncIncomplete";
}

class WorkspaceUnavailable extends Data.TaggedError("WorkspaceUnavailable")<{
  readonly cause: unknown;
}> {}

export type WorkspaceFault = WorkspaceUnavailable | WorkspaceSyncIncomplete;

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

// oxlint-disable-next-line anti-slop/no-unknown-returns -- The value is only ever logged redacted, never parsed.
export function thrownBy(fault: WorkspaceFault): unknown {
  return fault instanceof WorkspaceUnavailable ? fault.cause : fault;
}

/**
 * A surface answers both with its generic code and logs the cause redacted, so a programming
 * fault is never serialized to a caller.
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
