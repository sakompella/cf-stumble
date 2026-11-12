import type {
  Workspace,
  WorkspaceRuntimeEvent,
  WorkspaceRuntimeTruncation,
} from "@cloudflare/computer";
import { shellQuote } from "../../shell-quote.js";
import { WORKSPACE_ROOT } from "../../workspace-layout.js";
import {
  ContainerRestartedError,
  ISOLATE_BACKEND_ID,
  type ContainerLifecycleState,
} from "./exec-backend.js";
import type {
  BackendExecEvent,
  ExecBackend,
  ExecBackendHandle,
  ExecBackendInput,
} from "./exec-backend.js";
import type { ProjectFilesystemProvider, ProjectTransactions } from "./provider.js";

type RuntimeReader = Readonly<{
  read(): Promise<
    { done: true; value?: undefined } | { done: false; value: WorkspaceRuntimeEvent }
  >;
  cancel(): Promise<void>;
}>;

type RuntimeExecHandle = Readonly<{
  getReader(): RuntimeReader;
  kill(): Promise<void>;
}>;

type RuntimeExecOptions = Readonly<{
  backend: string;
  cwd: string;
  timeoutMs: number;
  encoding: undefined;
}>;

type PullProgress = Readonly<{ skipped: number; complete: boolean }>;

export type ExecWorkspace = Readonly<{
  runtime: Readonly<{
    exec(command: string, options: RuntimeExecOptions): Promise<RuntimeExecHandle>;
  }>;
  pull(backendId?: string): AsyncIterable<PullProgress>;
}>;

export function computerFilesystemProvider(workspace: Workspace): ProjectFilesystemProvider {
  const provider = workspace.provider();

  return {
    lstatSync: (path) => provider.lstatSync(path),
    readlinkSync: (path) => provider.readlinkSync(path),
    mkdirSync: (path) => {
      provider.mkdirSync(path);
    },
    openSync: (path, flags) => provider.openSync(path, flags),
    writeSync: (fd, buffer) => provider.writeSync(fd, buffer),
    closeSync: (fd) => {
      provider.closeSync(fd);
    },
    readFileSync: (path) => {
      const content = provider.readFileSync(path);

      return content instanceof Uint8Array ? content : new TextEncoder().encode(content);
    },
  };
}

export function durableObjectTransactions(storage: DurableObjectStorage): ProjectTransactions {
  return { transactionSync: (closure) => storage.transactionSync(closure) };
}

function processGroupCommand(command: string): string {
  const body = `trap 'kill -s KILL 0' TERM INT HUP; bash -c ${shellQuote(command)} & wait $!`;

  return `exec setsid /bin/sh -c ${shellQuote(body)}`;
}

function replacementGuard(containerState: ContainerLifecycleState | null) {
  const generation = containerState?.generation;

  return {
    replaced: (): boolean => generation !== undefined && containerState?.generation !== generation,
  };
}

type ReplacementGuard = ReturnType<typeof replacementGuard>;

function guardedReader(
  workspace: ExecWorkspace,
  backendId: string,
  reader: RuntimeReader,
  guard: ReplacementGuard,
): ExecBackendHandle["reader"] {
  return {
    async read() {
      try {
        const next = await reader.read();

        if (guard.replaced()) throw new ContainerRestartedError();

        if (next.done) return { done: true };

        if (next.value.name === "exit") {
          await waitForPostCommandSync(reader);

          if (guard.replaced()) throw new ContainerRestartedError();

          await durablePull(workspace, backendId);

          if (guard.replaced()) throw new ContainerRestartedError();
        }

        return { done: false, value: toBackendEvent(next.value) };
      } catch (cause) {
        if (guard.replaced()) throw new ContainerRestartedError();

        throw cause;
      }
    },
    cancel: () => reader.cancel(),
  };
}

async function waitForPostCommandSync(reader: RuntimeReader): Promise<void> {
  while (!(await reader.read()).done);
}

async function durablePull(workspace: ExecWorkspace, backendId: string): Promise<void> {
  for await (const block of workspace.pull(backendId)) {
    if (block.skipped > 0) throw new Error(`post-command pull skipped ${block.skipped} entries`);

    if (block.complete) return;
  }

  throw new Error("post-command pull ended incomplete");
}

export function computerExecBackend(
  workspace: ExecWorkspace,
  backendId: string,
  containerState: ContainerLifecycleState | null,
): ExecBackend {
  return {
    async exec(input: ExecBackendInput): Promise<ExecBackendHandle> {
      const guard = replacementGuard(containerState);

      const source =
        backendId === ISOLATE_BACKEND_ID ? input.command : processGroupCommand(input.command);

      const handle = await workspace.runtime
        .exec(source, {
          backend: backendId,
          cwd: input.cwd,
          timeoutMs: input.timeoutMs,
          encoding: undefined,
        })
        .catch((cause: unknown) => {
          if (guard.replaced()) throw new ContainerRestartedError();

          throw cause;
        });

      if (guard.replaced()) {
        await handle.kill().catch(() => {});
        throw new ContainerRestartedError();
      }

      return {
        reader: guardedReader(workspace, backendId, handle.getReader(), guard),
        kill: () => handle.kill(),
        backend: backendId === ISOLATE_BACKEND_ID ? "isolate" : "container",
      };
    },
  };
}

function savedOutputPaths(truncation: WorkspaceRuntimeTruncation): readonly string[] {
  return [truncation.stdout, truncation.stderr]
    .flatMap((saved) => (saved?.status === "saved" ? [saved.path] : []))
    .flatMap((path) =>
      path.startsWith(`${WORKSPACE_ROOT}/`) ? [path.slice(WORKSPACE_ROOT.length)] : [],
    );
}

function toBackendEvent(event: WorkspaceRuntimeEvent): BackendExecEvent {
  if (event.name !== "exit") return { name: event.name, data: event.value };

  const exited: BackendExecEvent = { name: "exit", exitCode: event.code };

  if (event.truncated !== undefined) exited.fullOutputPaths = savedOutputPaths(event.truncated);

  return exited;
}
