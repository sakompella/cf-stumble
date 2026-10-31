import type { Workspace, WorkspaceRuntimeEvent } from "@cloudflare/computer";
import { shellQuote } from "../../shell-quote.js";
import { ContainerRestartedError, type ContainerLifecycleState } from "./exec-backend.js";
import type {
  BackendExecEvent,
  ExecBackend,
  ExecBackendHandle,
  ExecBackendInput,
} from "./exec-backend.js";
import type { ProjectDirent, ProjectFilesystemProvider, ProjectTransactions } from "./provider.js";

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

export type ExecWorkspace = Readonly<{
  runtime: Readonly<{
    exec(command: string, options: RuntimeExecOptions): Promise<RuntimeExecHandle>;
  }>;
}>;

function isDirent<Entry extends string | ProjectDirent>(
  entry: Entry,
): entry is Exclude<Entry, string> {
  return typeof entry !== "string";
}

export function computerFilesystemProvider(workspace: Workspace): ProjectFilesystemProvider {
  const provider = workspace.provider();

  return {
    lstatSync: (path) => provider.lstatSync(path),
    readlinkSync: (path) => provider.readlinkSync(path),
    mkdirSync: (path) => {
      provider.mkdirSync(path);
    },
    readdirSync: (path, options) =>
      provider.readdirSync(path, options).filter((entry) => isDirent(entry)),
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

export function processGroupCommand(command: string): string {
  const body = `trap 'kill -s KILL 0' TERM INT HUP; /bin/sh -c ${shellQuote(command)} & wait $!`;

  return `exec setsid /bin/sh -c ${shellQuote(body)}`;
}

function replacementGuard(containerState: ContainerLifecycleState | undefined) {
  const generation = containerState?.generation;

  return {
    replaced: (): boolean => generation !== undefined && containerState?.generation !== generation,
  };
}

type ReplacementGuard = ReturnType<typeof replacementGuard>;

function guardedReader(
  reader: RuntimeReader,
  guard: ReplacementGuard,
): ExecBackendHandle["reader"] {
  return {
    async read() {
      try {
        const next = await reader.read();

        if (guard.replaced()) throw new ContainerRestartedError();

        if (next.done) return { done: true };

        return { done: false, value: toBackendEvent(next.value) };
      } catch (cause) {
        if (guard.replaced()) throw new ContainerRestartedError();

        throw cause;
      }
    },
    cancel: () => reader.cancel(),
  };
}

export function computerExecBackend(
  workspace: ExecWorkspace,
  backendId = "container-shell",
  containerState?: ContainerLifecycleState,
): ExecBackend {
  return {
    async exec(input: ExecBackendInput): Promise<ExecBackendHandle> {
      const guard = replacementGuard(containerState);

      const handle = await workspace.runtime
        .exec(processGroupCommand(input.command), {
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

      return { reader: guardedReader(handle.getReader(), guard), kill: () => handle.kill() };
    },
  };
}

function toBackendEvent(event: WorkspaceRuntimeEvent): BackendExecEvent {
  if (event.name === "exit") return { name: "exit", exitCode: event.code };

  return { name: event.name, data: event.value };
}
