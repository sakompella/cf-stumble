import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type { Project } from "../project-catalog.js";

export type WorkspacePathKind = "file" | "directory" | "symbolic-link";

export type CommandOutput = Readonly<{ stdout: string; stderr: string; exitCode: number }>;

export class WorkspaceSyncIncomplete extends Data.TaggedError("WorkspaceSyncIncomplete")<{
  readonly message: string;
}> {}

export class RepositoryNotEligible extends Data.TaggedError("RepositoryNotEligible")<{
  readonly message: string;
}> {}

export class WorkspaceUnavailable extends Data.TaggedError("WorkspaceUnavailable")<{
  readonly cause: unknown;
}> {}

export type WorkspaceFault = WorkspaceUnavailable | WorkspaceSyncIncomplete | RepositoryNotEligible;

export type WorkspaceEffects = Readonly<{
  cloneProject?(project: Project): Effect.Effect<void, WorkspaceFault>;
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

export function answerFailures<A>(
  answer: (cause: unknown) => A,
): (work: Effect.Effect<A, WorkspaceFault>) => Effect.Effect<A> {
  return (work) =>
    work.pipe(
      Effect.catch((fault) =>
        Effect.sync(() => answer(fault instanceof WorkspaceUnavailable ? fault.cause : fault)),
      ),
      Effect.catchDefect((defect) => Effect.sync(() => answer(defect))),
    );
}

type PlannedCommand = Readonly<{ source: string; cwd: string; timeoutMs: number }>;

export function runPlannedCommand(
  operations: WorkspaceEffects,
  plan: PlannedCommand,
  stdin?: string,
): Effect.Effect<CommandOutput, WorkspaceFault> {
  return operations.runCommand(plan.source, plan.cwd, plan.timeoutMs, stdin);
}
