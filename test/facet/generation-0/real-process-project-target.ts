// oxlint-disable anti-slop/no-unknown-parameters -- Mirrors the RPC boundary contract the real target declares.

import { spawn } from "node:child_process";
import { startExecOperation, type ExecOperation } from "../../../src/workspace/project/exec-operation.js";
import { providerPathOf } from "../../../src/workspace/project/resolve.js";
import { parseStartExecInput } from "../../../src/workspace/project/start-exec-input.js";
import { fail, ok } from "../../../src/workspace/project/protocol.js";
import { WORKSPACE_ROOT } from "../../../src/workspace-layout.js";
import type {
  BackendExecEvent,
  ExecBackend,
  ExecBackendHandle,
  ExecBackendInput,
} from "../../../src/workspace/project/index.js";
import type {
  ProjectFileInfo,
  ProjectLstatInfo,
  ProjectResult,
  ProjectRpcTargetContract,
} from "../../../src/workspace/project/protocol.js";

/**
 * A real process behind the project target's exec port, for the Node test project only.
 *
 * It is deliberately ignorant of what it runs: it takes a command string and a directory and
 * starts a shell there, exactly as `computerExecBackend` hands the string to the container's
 * runtime. Nothing here imports `TURN_DIFF_COMMAND` or looks at the command's text, which is the
 * whole point — the command the harness runs has to come from production, so a production change
 * to a command that cannot describe a repository turns the test red instead of following it.
 *
 * `stdin` is closed rather than inherited, so a command that reads standard input ends instead of
 * waiting for a terminal that does not exist.
 */
function realProcessBackend(workspaceDirectory: string): ExecBackend {
  return {
    exec(input: ExecBackendInput): Promise<ExecBackendHandle> {
      const child = spawn(input.command, {
        cwd: realPath(workspaceDirectory, input.cwd),
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      return Promise.resolve(handleOf(child));
    },
  };
}

/** Where a workspace-rooted path lives inside the temporary directory standing in for the container. */
function realPath(workspaceDirectory: string, path: string): string {
  return path === WORKSPACE_ROOT
    ? workspaceDirectory
    : `${workspaceDirectory}${path.slice(WORKSPACE_ROOT.length)}`;
}

type ChildProcess = ReturnType<typeof spawn>;

/** Queues one child process's output and exit as `BackendExecEvent`s a reader can pull. */
function handleOf(child: ChildProcess): ExecBackendHandle {
  const queued: BackendExecEvent[] = [];
  let ended = false;
  let wake: (() => void) | undefined;
  const push = (event: BackendExecEvent): void => {
    queued.push(event);
    const resume = wake;
    wake = undefined;
    resume?.();
  };

  child.stdout?.on("data", (chunk: Buffer) => push({ name: "stdout", data: bytesOf(chunk) }));
  child.stderr?.on("data", (chunk: Buffer) => push({ name: "stderr", data: bytesOf(chunk) }));
  child.on("close", (code) => {
    push({ name: "exit", exitCode: code ?? 0 });
    ended = true;
  });
  child.on("error", () => {
    ended = true;
    const resume = wake;
    wake = undefined;
    resume?.();
  });

  return {
    reader: {
      async read() {
        for (;;) {
          const next = queued.shift();
          if (next !== undefined) return { done: false as const, value: next };
          if (ended) return { done: true as const };
          // oxlint-disable-next-line no-await-in-loop -- Waits for the next chunk this child prints.
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
      },
      cancel(): Promise<void> {
        child.kill("SIGKILL");
        return Promise.resolve();
      },
    },
    kill(): Promise<void> {
      child.kill("SIGKILL");
      return Promise.resolve();
    },
  };
}

function bytesOf(chunk: Buffer): Uint8Array {
  return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength).slice();
}

/**
 * The project RPC target's exec half over real processes, in Node.
 *
 * The deployed `ProjectRpcTarget` extends `RpcTarget` from `cloudflare:workers`, which the Node
 * test project cannot import, so this stands in for the class — and only for the class. Command
 * parsing (`parseStartExecInput`), address translation (`providerPathOf`), the operation lifecycle
 * and its NDJSON event framing (`startExecOperation`) are all the production modules, so a turn
 * reaching this target crosses the same protocol it crosses in the deployed harness.
 *
 * The four filesystem methods are not implemented: the diff path never calls them, and a stand-in
 * that answered them would be pretending to be a filesystem the temporary directory already is.
 */
export class RealProcessProjectTarget implements ProjectRpcTargetContract {
  readonly #backend: ExecBackend;
  readonly #operations = new Map<string, ExecOperation>();
  #nextOperation = 0;

  constructor(workspaceDirectory: string) {
    this.#backend = realProcessBackend(workspaceDirectory);
  }

  lstat(): Promise<ProjectResult<ProjectLstatInfo>> {
    return Promise.resolve(fail("backend-unavailable"));
  }

  readFile(): Promise<ProjectResult<Uint8Array>> {
    return Promise.resolve(fail("backend-unavailable"));
  }

  writeFile(): Promise<ProjectResult<null>> {
    return Promise.resolve(fail("backend-unavailable"));
  }

  listFiles(): Promise<ProjectResult<readonly ProjectFileInfo[]>> {
    return Promise.resolve(fail("backend-unavailable"));
  }

  startExec(
    input: unknown,
  ): Promise<ProjectResult<{ operationId: string; events: ReadableStream<Uint8Array> }>> {
    const parsed = parseStartExecInput(input);
    if (!parsed.ok) return Promise.resolve(parsed);
    const operationId = `node:${this.#nextOperation++}`;
    const operation = startExecOperation(
      this.#backend,
      {
        command: parsed.value.command,
        cwd: providerPathOf(parsed.value.cwdSegments),
        timeoutMs: parsed.value.timeoutMs,
      },
      () => {
        this.#operations.delete(operationId);
      },
    );
    this.#operations.set(operationId, operation);
    return Promise.resolve(ok({ operationId, events: operation.events }));
  }

  kill(operationId: unknown): Promise<ProjectResult<null>> {
    if (typeof operationId !== "string") return Promise.resolve(fail("invalid-request"));
    this.#operations.get(operationId)?.requestKill();
    return Promise.resolve(ok(null));
  }
}
