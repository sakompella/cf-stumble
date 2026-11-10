import * as Result from "effect/Result";
import { RpcTarget } from "cloudflare:workers";
import type { ExecBackend } from "./exec-backend.js";
import { startExecOperation, type ExecOperation, type TerminalEvent } from "./exec-operation.js";
import type { ProjectActivity } from "../idle-controller.js";
import {
  lstatProjectPath,
  projectResultOf,
  readProjectFile,
  writeProjectFile,
} from "./file-operations.js";
import {
  mapProviderError,
  type ProjectFilesystemProvider,
  type ProjectTransactions,
} from "./provider.js";
import { addressedPathOf, resolveAddressedPath } from "./resolve.js";
import {
  failureDetail,
  fail,
  MAX_CONCURRENT_EXECS,
  ok,
  type ProjectFailure,
  type ProjectFailureDetail,
  type ProjectLstatInfo,
  type ProjectResult,
  type ProjectRpcTargetContract,
  type StartExecWire,
  type WriteMode,
} from "./protocol.js";
import {
  parseOperationId,
  parseStartExecInput,
  type ParsedStartExecInput,
} from "./start-exec-input.js";

type StartedExec = { operationId: string; events: ReadableStream<Uint8Array> };

type ProjectContainerState = Readonly<{ generation: number }>;

type ProjectRpcTargetOptions = Readonly<{
  remainingMs?: number;
  containerState?: ProjectContainerState;
  activity?: ProjectActivity;
  endLease?: () => void;
}>;

function capAtBudget(requestedMs: number, remainingMs: number | undefined) {
  if (remainingMs === undefined) return { timeoutMs: requestedMs, timeoutEndsTurn: false };

  return {
    timeoutMs: Math.min(requestedMs, remainingMs),
    timeoutEndsTurn: requestedMs >= remainingMs,
  };
}

function reportsRestart(terminal: TerminalEvent): boolean {
  return terminal.outcome === "failed" && terminal.error.code === "container-restarted";
}

function projectResult<T>(operation: () => ProjectResult<T>): Promise<ProjectResult<T>> {
  try {
    return Promise.resolve(operation());
  } catch (cause) {
    return Promise.resolve(fail(mapProviderError(cause)));
  }
}

export class ProjectRpcTarget extends RpcTarget implements ProjectRpcTargetContract {
  readonly #provider: ProjectFilesystemProvider;
  readonly #transactions: ProjectTransactions;
  readonly #execBackend: ExecBackend;
  readonly #operations = new Map<string, ExecOperation>();
  readonly #nonce: string;
  readonly #turnEndsAt: number | undefined;
  readonly #containerState: ProjectContainerState | undefined;
  readonly #activity: ProjectActivity | undefined;
  readonly #endLease: (() => void) | undefined;
  #containerGeneration: number | undefined;
  #turnTimer: ReturnType<typeof setTimeout> | undefined;
  #ended = false;
  #endResult: { killed: number } | undefined;
  #nextOperationSequence = 0;

  constructor(
    provider: ProjectFilesystemProvider,
    transactions: ProjectTransactions,
    execBackend: ExecBackend,
    options: ProjectRpcTargetOptions = {},
  ) {
    super();
    this.#provider = provider;
    this.#transactions = transactions;
    this.#execBackend = execBackend;
    this.#nonce = crypto.randomUUID();
    this.#containerState = options.containerState;
    this.#activity = options.activity;
    this.#endLease = options.endLease;
    this.#containerGeneration = options.containerState?.generation;
    this.#turnEndsAt =
      options.remainingMs === undefined ? undefined : Date.now() + options.remainingMs;
    this.#armTurnTimer();
  }

  lstat(path: string): Promise<ProjectResult<ProjectLstatInfo>> {
    return this.#whileTurnLasts(() => projectResultOf(lstatProjectPath(this.#provider, path)));
  }

  readFile(path: string): Promise<ProjectResult<Uint8Array>> {
    return this.#whileTurnLasts(() => projectResultOf(readProjectFile(this.#provider, path)));
  }

  writeFile(path: string, bytes: Uint8Array, mode: WriteMode): Promise<ProjectResult<null>> {
    return this.#whileTurnLasts(() =>
      projectResultOf(writeProjectFile(this.#provider, this.#transactions, { path, bytes, mode })),
    );
  }

  startExec(input: StartExecWire): Promise<ProjectResult<StartedExec>> {
    const ended = this.#turnEnded();

    if (ended !== undefined) {
      return Promise.resolve(ended);
    }

    this.#activity?.touch();

    return projectResult<StartedExec>(() => {
      const parsed = parseStartExecInput(input);

      return parsed.ok ? projectResultOf(this.#startExec(parsed.value)) : parsed;
    });
  }

  #startExec(input: ParsedStartExecInput): Result.Result<StartedExec, ProjectFailureDetail> {
    return Result.gen(this, function* () {
      if (this.#containerWasReplaced()) {
        this.#acknowledgeRestart();

        return yield* Result.fail(failureDetail("container-restarted"));
      }

      if (this.#operations.size >= MAX_CONCURRENT_EXECS) {
        return yield* Result.fail(failureDetail("too-many-operations"));
      }

      const cwd = yield* resolveAddressedPath(this.#provider, input.cwdSegments, {
        followFinalSymlink: true,
        createMissingDirs: false,
      });

      if (cwd.kind === "missing") {
        return yield* Result.fail(failureDetail("not-found", addressedPathOf(input.cwdSegments)));
      }

      if (!cwd.stat.isDirectory()) {
        return yield* Result.fail(
          failureDetail("not-directory", addressedPathOf(input.cwdSegments)),
        );
      }

      const remainingMs =
        this.#turnEndsAt === undefined ? undefined : Math.max(0, this.#turnEndsAt - Date.now());

      if (remainingMs !== undefined && remainingMs <= 0) {
        void this.endTurn();

        return yield* Result.fail(failureDetail("turn-ended"));
      }

      const { timeoutMs, timeoutEndsTurn } = capAtBudget(input.timeoutMs, remainingMs);

      const operationId = `${this.#nonce}:${this.#nextOperationSequence++}`;

      const endActivity = this.#activity?.begin();

      const operation = this.#startOperation(
        operationId,
        cwd.path,
        input,
        timeoutMs,
        timeoutEndsTurn,
        endActivity,
      );

      this.#operations.set(operationId, operation);

      return { operationId, events: operation.events };
    });
  }

  #startOperation(
    operationId: string,
    cwd: string,
    input: ParsedStartExecInput,
    timeoutMs: number,
    timeoutEndsTurn: boolean,
    endActivity: (() => void) | undefined,
  ): ExecOperation {
    try {
      return startExecOperation(
        this.#execBackend,
        { command: input.command, cwd, timeoutMs, backend: input.backend },
        (terminal) => {
          this.#operations.delete(operationId);

          if (reportsRestart(terminal)) this.#acknowledgeRestart();
          endActivity?.();
        },
        timeoutEndsTurn,
      );
    } catch (cause) {
      endActivity?.();

      throw cause;
    }
  }

  kill(operationId: string): Promise<ProjectResult<null>> {
    return projectResult(() => {
      const parsed = parseOperationId(operationId);

      return parsed.ok ? this.#kill(parsed.value) : parsed;
    });
  }

  #kill(operationId: string): ProjectResult<null> {
    this.#operations.get(operationId)?.requestKill();

    return ok(null);
  }

  endTurn(): Promise<ProjectResult<{ killed: number }>> {
    return projectResult(() => this.#endTurn());
  }

  #endTurn(): ProjectResult<{ killed: number }> {
    if (this.#endResult !== undefined) return ok(this.#endResult);
    this.#ended = true;

    if (this.#turnTimer !== undefined) {
      clearTimeout(this.#turnTimer);
      this.#turnTimer = undefined;
    }

    let killed = 0;

    for (const operation of this.#operations.values()) {
      killed += 1;
      operation.requestKill();
    }

    this.#endResult = { killed };
    this.#endLease?.();

    return ok(this.#endResult);
  }

  #armTurnTimer(): void {
    if (this.#turnEndsAt === undefined) return;
    const remaining = this.#turnEndsAt - Date.now();

    if (remaining <= 0) {
      this.#endTurn();

      return;
    }

    const delay = Math.min(remaining, 2_147_483_647);
    this.#turnTimer = setTimeout(() => {
      this.#turnTimer = undefined;
      this.#armTurnTimer();
    }, delay);
  }

  #acknowledgeRestart(): void {
    this.#containerGeneration = this.#containerState?.generation;
  }

  #containerWasReplaced(): boolean {
    return (
      this.#containerState !== undefined &&
      this.#containerState.generation !== this.#containerGeneration
    );
  }

  #turnEnded(): ProjectFailure | undefined {
    if (this.#ended) return { ok: false, error: { code: "turn-ended" } };

    if (this.#turnEndsAt !== undefined && Date.now() >= this.#turnEndsAt) {
      this.#endTurn();

      return { ok: false, error: { code: "turn-ended" } };
    }

    return undefined;
  }

  #whileTurnLasts<T>(operation: () => ProjectResult<T>): Promise<ProjectResult<T>> {
    const ended = this.#turnEnded();

    if (ended !== undefined) return Promise.resolve(ended);

    this.#activity?.touch();

    return projectResult(operation);
  }
}
