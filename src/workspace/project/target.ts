// oxlint-disable max-lines -- Capability lifetime, process cleanup, and RPC methods share one bounded target.
import { RpcTarget } from "cloudflare:workers";
import type { ExecBackend } from "./exec-backend.js";
import { startExecOperation, type ExecOperation } from "./exec-operation.js";
import type { ProjectActivity } from "../idle-controller.js";
import {
  mapProviderError,
  type ProjectFilesystemProvider,
  type ProjectTransactions,
} from "./provider.js";
import {
  addressedPathOf,
  fileInfoOf,
  joinOne,
  parseAddressedPath,
  resolveAddressedPath,
  resolveCanonicalPath,
} from "./resolve.js";
import {
  fail,
  MAX_CONCURRENT_EXECS,
  MAX_FILE_BYTES,
  MAX_LIST_BYTES,
  MAX_LIST_ENTRIES,
  ok,
  type ProjectFileInfo,
  type ProjectListing,
  type ProjectLstatInfo,
  type ProjectResult,
  type ProjectFailure,
  type ProjectRpcTargetContract,
  type WriteMode,
} from "./protocol.js";
import {
  isWriteMode,
  OPERATION_ID_PATTERN,
  parseStartExecInput,
  type ParsedStartExecInput,
} from "./start-exec-input.js";

type StartedExec = { operationId: string; events: ReadableStream<Uint8Array> };

type ProjectContainerState = Readonly<{ generation: number }>;

type ProjectRpcTargetOptions = Readonly<{
  remainingMs?: number;
  containerState?: ProjectContainerState;
  activity?: ProjectActivity;
  /** Called once when the turn ends, so the workspace is not held for the rest of the budget. */
  endLease?: () => void;
}>;

/** A timeout capped at the turn's budget means the turn ended, so the turn timer and exec timer must report the same outcome. */
function capAtBudget(requestedMs: number, remainingMs: number | undefined) {
  if (remainingMs === undefined) return { timeoutMs: requestedMs, timeoutEndsTurn: false };

  return {
    timeoutMs: Math.min(requestedMs, remainingMs),
    timeoutEndsTurn: requestedMs >= remainingMs,
  };
}

function projectResult<T>(operation: () => ProjectResult<T>): Promise<ProjectResult<T>> {
  try {
    return Promise.resolve(operation());
  } catch (error) {
    return Promise.resolve(fail(mapProviderError(error)));
  }
}

/**
 * Never exposes a build, fetch, raw Computer, container, or other generic capability. Filesystem
 * methods confine paths beneath the workspace root; `startExec` confines its working directory
 * there while accepting an arbitrary shell command.
 */
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

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- This is the RPC boundary; `#lstat` parses `path`.
  lstat(path: unknown): Promise<ProjectResult<ProjectLstatInfo>> {
    return this.#whileTurnLasts(() => this.#lstat(path));
  }

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- This is the RPC boundary; `#readFile` parses `path`.
  readFile(path: unknown): Promise<ProjectResult<Uint8Array>> {
    return this.#whileTurnLasts(() => this.#readFile(path));
  }

  writeFile(
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- This is the RPC boundary; `#writeFile` parses every argument.
    path: unknown,
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- This is the RPC boundary; `#writeFile` parses every argument.
    bytes: unknown,
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- This is the RPC boundary; `#writeFile` parses every argument.
    mode: unknown,
  ): Promise<ProjectResult<null>> {
    return this.#whileTurnLasts(() => this.#writeFile(path, bytes, mode));
  }

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- This is the RPC boundary; `#listFiles` parses `path`.
  listFiles(path: unknown): Promise<ProjectResult<ProjectListing>> {
    return this.#whileTurnLasts(() => this.#listFiles(path));
  }

  startExec(
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- This is the RPC boundary; `parseStartExecInput` parses `input`.
    input: unknown,
  ): Promise<ProjectResult<StartedExec>> {
    const ended = this.#turnEnded();

    if (ended !== undefined) {
      return Promise.resolve(ended);
    }

    this.#activity?.touch();

    return projectResult<StartedExec>(() => {
      const parsed = parseStartExecInput(input);

      if (!parsed.ok) {
        return parsed;
      }

      return this.#startExec(parsed.value);
    });
  }

  #startExec(input: ParsedStartExecInput): ProjectResult<StartedExec> {
    if (this.#containerWasReplaced()) {
      // Files are durable across a replacement. Refuse only this first exec so callers get an
      // explicit restart outcome, then permit a retry against the new container.
      this.#containerGeneration = this.#containerState?.generation;

      return fail("container-restarted");
    }

    if (this.#operations.size >= MAX_CONCURRENT_EXECS) {
      return fail("too-many-operations");
    }

    const cwdOutcome = resolveAddressedPath(this.#provider, input.cwdSegments, {
      followFinalSymlink: true,
      createMissingDirs: false,
    });

    if (!cwdOutcome.ok) return cwdOutcome;

    if (cwdOutcome.value.kind === "missing") {
      return fail("not-found", addressedPathOf(input.cwdSegments));
    }

    if (!cwdOutcome.value.stat.isDirectory()) {
      return fail("not-directory", addressedPathOf(input.cwdSegments));
    }

    const remainingMs =
      this.#turnEndsAt === undefined ? undefined : Math.max(0, this.#turnEndsAt - Date.now());

    if (remainingMs !== undefined && remainingMs <= 0) {
      void this.endTurn();

      return fail("turn-ended");
    }

    const { timeoutMs, timeoutEndsTurn } = capAtBudget(input.timeoutMs, remainingMs);

    const operationId = `${this.#nonce}:${this.#nextOperationSequence++}`;

    // The operation holds the workspace until it settles, even past the turn's deadline.
    const endActivity = this.#activity?.begin();

    const operation = this.#startOperation(
      operationId,
      cwdOutcome.value.path,
      input,
      timeoutMs,
      timeoutEndsTurn,
      endActivity,
    );

    this.#operations.set(operationId, operation);

    return ok({ operationId, events: operation.events });
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
        { command: input.command, cwd, timeoutMs },
        () => {
          this.#operations.delete(operationId);
          endActivity?.();
        },
        timeoutEndsTurn,
      );
    } catch (error) {
      endActivity?.();

      throw error;
    }
  }

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- This is the RPC boundary; `operationId` is validated below.
  kill(operationId: unknown): Promise<ProjectResult<null>> {
    return projectResult(() => {
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Boundary: the RPC operation id is untrusted.
      if (typeof operationId !== "string" || !OPERATION_ID_PATTERN.test(operationId)) {
        return fail("invalid-request");
      }

      return this.#kill(operationId);
    });
  }

  #kill(operationId: string): ProjectResult<null> {
    this.#operations.get(operationId)?.requestKill();

    return ok(null);
  }

  endTurn(): Promise<ProjectResult<{ killed: number }>> {
    return projectResult(() => this.#endTurn("end-turn"));
  }

  #endTurn(reason: "end-turn" | "turn-end" = "end-turn"): ProjectResult<{ killed: number }> {
    if (this.#endResult !== undefined) return ok(this.#endResult);
    this.#ended = true;

    if (this.#turnTimer !== undefined) {
      clearTimeout(this.#turnTimer);
      this.#turnTimer = undefined;
    }

    let killed = 0;

    for (const operation of this.#operations.values()) {
      killed += 1;
      operation.requestKill(reason);
    }

    this.#endResult = { killed };
    this.#endLease?.();

    return ok(this.#endResult);
  }

  #armTurnTimer(): void {
    if (this.#turnEndsAt === undefined) return;
    const remaining = this.#turnEndsAt - Date.now();

    if (remaining <= 0) {
      this.#endTurn("turn-end");

      return;
    }

    // setTimeout clamps values above 2^31-1 to an immediate callback. Re-arm long budgets so the
    // capability does not end early and still owns one bounded timer until its deadline.
    const delay = Math.min(remaining, 2_147_483_647);
    this.#turnTimer = setTimeout(() => {
      this.#turnTimer = undefined;
      this.#armTurnTimer();
    }, delay);
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
      this.#endTurn("turn-end");

      return { ok: false, error: { code: "turn-ended" } };
    }

    return undefined;
  }

  /** A container replacement does not refuse file access: the files are durable, so only a command needs to hear that its container changed. */
  #whileTurnLasts<T>(operation: () => ProjectResult<T>): Promise<ProjectResult<T>> {
    const ended = this.#turnEnded();

    if (ended !== undefined) return Promise.resolve(ended);

    this.#activity?.touch();

    return projectResult(operation);
  }

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- This is the RPC boundary; `parseAddressedPath` parses `path` immediately below.
  #lstat(path: unknown): ProjectResult<ProjectLstatInfo> {
    const segments = parseAddressedPath(path);

    if (!segments.ok) return segments;

    const outcome = resolveAddressedPath(this.#provider, segments.value, {
      followFinalSymlink: false,
      createMissingDirs: false,
    });

    if (!outcome.ok) return outcome;

    if (outcome.value.kind === "missing") return fail("not-found", addressedPathOf(segments.value));

    const name = segments.value.at(-1) ?? "/";

    const info = fileInfoOf(
      this.#provider,
      name,
      addressedPathOf(segments.value),
      outcome.value.path,
      outcome.value.stat,
    );

    const canonicalPath = resolveCanonicalPath(this.#provider, segments.value);

    return ok({ ...info, canonicalPath });
  }

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- This is the RPC boundary; `parseAddressedPath` parses `path` immediately below.
  #readFile(path: unknown): ProjectResult<Uint8Array> {
    const segments = parseAddressedPath(path);

    if (!segments.ok) return segments;

    const outcome = resolveAddressedPath(this.#provider, segments.value, {
      followFinalSymlink: true,
      createMissingDirs: false,
    });

    if (!outcome.ok) return outcome;

    if (outcome.value.kind === "missing") return fail("not-found", addressedPathOf(segments.value));

    if (outcome.value.stat.isDirectory()) {
      return fail("is-directory", addressedPathOf(segments.value));
    }

    if (outcome.value.stat.size > MAX_FILE_BYTES) {
      return fail("content-too-large", addressedPathOf(segments.value));
    }

    try {
      return ok(this.#provider.readFileSync(outcome.value.path));
    } catch (error) {
      return fail(mapProviderError(error), addressedPathOf(segments.value));
    }
  }

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- This is the RPC boundary; every argument is parsed immediately below.
  #writeFile(path: unknown, bytes: unknown, mode: unknown): ProjectResult<null> {
    const segments = parseAddressedPath(path);

    if (!segments.ok) return segments;

    if (!(bytes instanceof Uint8Array)) return fail("invalid-request");

    if (!isWriteMode(mode)) return fail("invalid-request");

    if (bytes.byteLength > MAX_FILE_BYTES) {
      return fail("content-too-large", addressedPathOf(segments.value));
    }

    const addressed = addressedPathOf(segments.value);
    const target = this.#resolveWriteTarget(segments.value, mode);

    if (!target.ok) return target;

    try {
      this.#transactions.transactionSync(() => {
        const fd = this.#provider.openSync(target.value.path, target.value.flag);

        try {
          this.#provider.writeSync(fd, bytes);
        } finally {
          this.#provider.closeSync(fd);
        }
      });

      return ok(null);
    } catch (error) {
      return fail(mapProviderError(error), addressed);
    }
  }

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- This is the RPC boundary; `parseAddressedPath` parses `path` immediately below.
  #listFiles(path: unknown): ProjectResult<ProjectListing> {
    const segments = parseAddressedPath(path);

    if (!segments.ok) return segments;

    const outcome = resolveAddressedPath(this.#provider, segments.value, {
      followFinalSymlink: true,
      createMissingDirs: false,
    });

    if (!outcome.ok) return outcome;

    if (outcome.value.kind === "missing") return fail("not-found", addressedPathOf(segments.value));

    if (!outcome.value.stat.isDirectory()) {
      return fail("not-directory", addressedPathOf(segments.value));
    }

    const directoryPath = outcome.value.path;

    try {
      const names = this.#provider
        .readdirSync(directoryPath, { withFileTypes: true })
        .map((entry) => entry.name)
        .toSorted((a, b) => a.localeCompare(b));

      const entries: ProjectFileInfo[] = [];
      let bytes = 0;

      for (const name of names) {
        const childAddressed = joinOne(addressedPathOf(segments.value), name);
        bytes += new TextEncoder().encode(childAddressed).length;

        if (entries.length >= MAX_LIST_ENTRIES || bytes > MAX_LIST_BYTES) {
          return ok({ entries, truncated: true });
        }

        const childProviderPath = joinOne(directoryPath, name);
        const stat = this.#provider.lstatSync(childProviderPath);
        entries.push(fileInfoOf(this.#provider, name, childAddressed, childProviderPath, stat));
      }

      return ok({ entries, truncated: false });
    } catch (error) {
      return fail(mapProviderError(error), addressedPathOf(segments.value));
    }
  }

  #resolveWriteTarget(
    segments: readonly string[],
    mode: WriteMode,
  ): ProjectResult<{ path: string; flag: "w" | "a" | "wx" }> {
    const addressed = addressedPathOf(segments);

    if (mode === "create-exclusive") {
      const outcome = resolveAddressedPath(this.#provider, segments, {
        followFinalSymlink: false,
        createMissingDirs: true,
      });

      if (!outcome.ok) return outcome;

      if (outcome.value.kind === "resolved") return fail("already-exists", addressed);

      return ok({ path: joinOne(outcome.value.parentPath, outcome.value.name), flag: "wx" });
    }

    const outcome = resolveAddressedPath(this.#provider, segments, {
      followFinalSymlink: true,
      createMissingDirs: true,
    });

    if (!outcome.ok) return outcome;

    if (outcome.value.kind === "resolved") {
      if (outcome.value.stat.isDirectory()) return fail("is-directory", addressed);

      return ok({ path: outcome.value.path, flag: mode === "append" ? "a" : "w" });
    }

    return ok({
      path: joinOne(outcome.value.parentPath, outcome.value.name),
      flag: mode === "append" ? "a" : "w",
    });
  }
}
