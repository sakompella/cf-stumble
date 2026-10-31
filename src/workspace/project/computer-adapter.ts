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

export function computerFilesystemProvider(workspace: Workspace): ProjectFilesystemProvider {
  const provider = workspace.provider();

  return {
    lstatSync: (path) => provider.lstatSync(path),
    readlinkSync: (path) => provider.readlinkSync(path),
    mkdirSync: (path) => {
      provider.mkdirSync(path);
    },
    readdirSync: (path, options) =>
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: `withFileTypes: true` is always passed, so the provider's untyped union is always the Dirent branch.
      provider.readdirSync(path, options) as ProjectDirent[],
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

// oxlint-disable-next-line max-lines-per-function -- The adapter wires process-group execution and container replacement detection in one port.
export function computerExecBackend(
  workspace: Workspace,
  backendId = "container-shell",
  containerState?: ContainerLifecycleState,
): ExecBackend {
  return {
    async exec(input: ExecBackendInput): Promise<ExecBackendHandle> {
      const generation = containerState?.generation;

      const handle = await workspace.runtime
        .exec(processGroupCommand(input.command), {
          backend: backendId,
          cwd: input.cwd,
          timeoutMs: input.timeoutMs,
          encoding: undefined,
        })
        .catch(
          // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Runtime rejects an untrusted backend value.
          (error: unknown) => {
            if (generation !== undefined && containerState?.generation !== generation) {
              throw new ContainerRestartedError();
            }

            throw error;
          },
        );

      if (generation !== undefined && containerState?.generation !== generation) {
        await handle.kill().catch(() => {});
        throw new ContainerRestartedError();
      }

      const reader = handle.getReader();

      return {
        reader: {
          async read() {
            try {
              const next = await reader.read();

              if (generation !== undefined && containerState?.generation !== generation) {
                throw new ContainerRestartedError();
              }

              if (next.done) return { done: true };

              return { done: false, value: toBackendEvent(next.value) };
            } catch (error) {
              if (generation !== undefined && containerState?.generation !== generation) {
                throw new ContainerRestartedError();
              }

              throw error;
            }
          },
          cancel: () => reader.cancel(),
        },
        kill: () => handle.kill(),
      };
    },
  };
}

function toBackendEvent(event: WorkspaceRuntimeEvent): BackendExecEvent {
  if (event.name === "exit") return { name: "exit", exitCode: event.code };

  return { name: event.name, data: event.value };
}
