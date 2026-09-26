import type { Workspace, WorkspaceRuntimeEvent } from "@cloudflare/computer";
import { ContainerRestartedError, type ContainerLifecycleState } from "./exec-backend.js";
import type {
  BackendExecEvent,
  ExecBackend,
  ExecBackendHandle,
  ExecBackendInput,
} from "./exec-backend.js";
import type { ProjectDirent, ProjectFilesystemProvider, ProjectTransactions } from "./provider.js";

/**
 * Adapts the real Computer `Workspace` to this target's narrow provider port. Every method here
 * is a direct, untranslated pass-through to `workspace.provider()`'s own sync methods; all
 * canonicalization, sandboxing, and mkdir-p logic lives in `resolve.ts`, not here.
 */
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

/**
 * Runs a write inside one synchronous Durable Object transaction.
 *
 * It has to be the Durable Object's own API rather than Computer's `workspace.db.transactionSync`.
 * The workspace's database *is* this object's SQLite storage, and a deployed write through
 * Computer's transaction reached the agent as `backend-unavailable` with the cause thrown away.
 * What the runtime actually said was: "To execute a transaction, please use the
 * state.storage.transaction() or state.storage.transactionSync() APIs instead of the SQL BEGIN
 * TRANSACTION or SAVEPOINT statements." So the write uses the API the runtime names, which is also
 * the one `generations/index.ts` and the module-map store already use.
 */
export function durableObjectTransactions(storage: DurableObjectStorage): ProjectTransactions {
  return { transactionSync: (closure) => storage.transactionSync(closure) };
}

/**
 * Keep each command in its own session. The pinned computerd runner signals only the direct shell,
 * so this wrapper keeps a TERM trap in the session leader and sends SIGKILL to the complete process
 * group. A nested shell keeps the trap installed even when the command uses `exec`.
 */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function processGroupCommand(command: string): string {
  const body = `trap 'kill -s KILL 0' TERM INT HUP; /bin/sh -c ${shellQuote(command)} & wait $!`;

  return `exec setsid /bin/sh -c ${shellQuote(body)}`;
}

/**
 * Adapts Computer's runtime to this target's exec port. `container-shell` matches the backend id
 * the existing generic executor uses for the same container backend registered on `WorkspaceHost`.
 */
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
