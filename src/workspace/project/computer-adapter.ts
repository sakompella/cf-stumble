import type { Workspace, WorkspaceRuntimeEvent } from "@cloudflare/computer";
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

/** Runs a write inside the workspace's own synchronous SQLite transaction. */
export function computerTransactions(workspace: Workspace): ProjectTransactions {
  return { transactionSync: (closure) => workspace.db.transactionSync(closure) };
}

/**
 * Adapts Computer's runtime to this target's exec port. `container-shell` matches the backend id
 * the existing generic executor uses for the same container backend registered on `WorkspaceHost`.
 */
export function computerExecBackend(
  workspace: Workspace,
  backendId = "container-shell",
): ExecBackend {
  return {
    async exec(input: ExecBackendInput): Promise<ExecBackendHandle> {
      const handle = await workspace.runtime.exec(input.command, {
        backend: backendId,
        cwd: input.cwd,
        timeoutMs: input.timeoutMs,
        encoding: undefined,
      });
      const reader = handle.getReader();
      return {
        reader: {
          async read() {
            const next = await reader.read();
            if (next.done) return { done: true };
            return { done: false, value: toBackendEvent(next.value) };
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
