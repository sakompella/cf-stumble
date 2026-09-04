import { RpcTarget } from "cloudflare:workers";
import type { ExecBackend } from "./exec-backend.js";
import { startExecOperation, type ExecOperation } from "./exec-operation.js";
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
  ok,
  type ExecEvent,
  type ProjectFileInfo,
  type ProjectLstatInfo,
  type ProjectResult,
  type ProjectRpcTargetContract,
  type WriteMode,
} from "./protocol.js";
import {
  isWriteMode,
  OPERATION_ID_PATTERN,
  parseStartExecInput,
  type ParsedStartExecInput,
} from "./start-exec-input.js";

type StartedExec = { operationId: string; events: ReadableStream<ExecEvent> };

function projectResult<T>(operation: () => ProjectResult<T>): Promise<ProjectResult<T>> {
  try {
    return Promise.resolve(operation());
  } catch (error) {
    return Promise.resolve(fail(mapProviderError(error)));
  }
}

/**
 * The narrow, project-only RPC surface for one Computer workspace: exactly `lstat`, `readFile`,
 * `writeFile`, `listFiles`, `startExec`, and `kill`. It never exposes a build, fetch, raw
 * Computer, container, or other generic capability. Its four filesystem methods confine addressed
 * paths beneath the fixed `/project` root, and `startExec` confines its working directory there
 * while accepting an arbitrary shell command.
 */
export class ProjectRpcTarget extends RpcTarget implements ProjectRpcTargetContract {
  readonly #provider: ProjectFilesystemProvider;
  readonly #transactions: ProjectTransactions;
  readonly #execBackend: ExecBackend;
  readonly #operations = new Map<string, ExecOperation>();
  readonly #nonce: string;
  #nextOperationSequence = 0;

  constructor(
    provider: ProjectFilesystemProvider,
    transactions: ProjectTransactions,
    execBackend: ExecBackend,
  ) {
    super();
    this.#provider = provider;
    this.#transactions = transactions;
    this.#execBackend = execBackend;
    this.#nonce = crypto.randomUUID();
  }

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- This is the RPC boundary; `#lstat` parses `path`.
  lstat(path: unknown): Promise<ProjectResult<ProjectLstatInfo>> {
    return projectResult(() => this.#lstat(path));
  }

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- This is the RPC boundary; `#readFile` parses `path`.
  readFile(path: unknown): Promise<ProjectResult<Uint8Array>> {
    return projectResult(() => this.#readFile(path));
  }

  writeFile(
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- This is the RPC boundary; `#writeFile` parses every argument.
    path: unknown,
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- This is the RPC boundary; `#writeFile` parses every argument.
    bytes: unknown,
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- This is the RPC boundary; `#writeFile` parses every argument.
    mode: unknown,
  ): Promise<ProjectResult<null>> {
    return projectResult(() => this.#writeFile(path, bytes, mode));
  }

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- This is the RPC boundary; `#listFiles` parses `path`.
  listFiles(path: unknown): Promise<ProjectResult<readonly ProjectFileInfo[]>> {
    return projectResult(() => this.#listFiles(path));
  }

  startExec(
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- This is the RPC boundary; `parseStartExecInput` parses `input`.
    input: unknown,
  ): Promise<ProjectResult<StartedExec>> {
    return projectResult<StartedExec>(() => {
      const parsed = parseStartExecInput(input);
      return parsed.ok ? this.#startExec(parsed.value) : parsed;
    });
  }

  #startExec(input: ParsedStartExecInput): ProjectResult<StartedExec> {
    if (this.#operations.size >= MAX_CONCURRENT_EXECS) return fail("too-many-operations");

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

    // The operation identity, its event stream, and its host timeout timer are all produced
    // synchronously here, before `execBackend.exec()` is ever awaited: see `startExecOperation`
    // for why a slow or never-settling backend handle must not leave this call, or the operation
    // it starts, unbounded.
    const operationId = `${this.#nonce}:${this.#nextOperationSequence++}`;
    const operation = startExecOperation(
      this.#execBackend,
      {
        command: input.command,
        cwd: cwdOutcome.value.path,
        timeoutMs: input.timeoutMs,
      },
      () => {
        this.#operations.delete(operationId);
      },
    );
    this.#operations.set(operationId, operation);
    return ok({ operationId, events: operation.events });
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
  #listFiles(path: unknown): ProjectResult<readonly ProjectFileInfo[]> {
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
      const entries = this.#provider.readdirSync(directoryPath, { withFileTypes: true });
      const infos = entries.map((entry) => {
        const childProviderPath = joinOne(directoryPath, entry.name);
        const childAddressed = joinOne(addressedPathOf(segments.value), entry.name);
        const stat = this.#provider.lstatSync(childProviderPath);
        return fileInfoOf(this.#provider, entry.name, childAddressed, childProviderPath, stat);
      });
      infos.sort((a, b) => a.name.localeCompare(b.name));
      return ok(infos);
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
