import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  writeSync,
} from "node:fs";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { createComputerEnv } from "../../../src/facet/generation-1/execution-env.js";
import {
  ProjectRpcTarget,
  type BackendExecEvent,
  type ExecBackend,
  type ProjectFilesystemProvider,
} from "../../../src/workspace/project/index.js";
import { WORKSPACE_ROOT } from "../../../src/workspace-layout.js";
import { FakeProjectTransactions } from "../../workspace/project/fakes.js";

/** `root` stands in for the container's `/workspace`, which is all a provider or backend sees. */
function hostPath(root: string, path: string): string {
  if (path !== WORKSPACE_ROOT && !path.startsWith(`${WORKSPACE_ROOT}/`)) {
    throw new Error(`not a workspace path: ${path}`);
  }

  return `${root}${path.slice(WORKSPACE_ROOT.length)}`;
}

export function hostFilesystemProvider(root: string): ProjectFilesystemProvider {
  return {
    lstatSync: (path) => lstatSync(hostPath(root, path)),
    readlinkSync: (path) => readlinkSync(hostPath(root, path)),
    mkdirSync: (path) => {
      mkdirSync(hostPath(root, path));
    },
    readdirSync: (path, options) => readdirSync(hostPath(root, path), options),
    openSync: (path, flags) => openSync(hostPath(root, path), flags),
    writeSync: (fd, buffer) => writeSync(fd, buffer),
    closeSync: (fd) => {
      closeSync(fd);
    },
    readFileSync: (path) => new Uint8Array(readFileSync(hostPath(root, path))),
  };
}

/** Runs each command in its own process group, as the Computer adapter does, so a kill reaches its children. */
export function hostExecBackend(root: string): ExecBackend {
  return {
    exec(input) {
      const child = spawn("/bin/sh", ["-c", input.command], {
        cwd: hostPath(root, input.cwd),
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let cancelled = false;

      const events = new ReadableStream<BackendExecEvent>({
        start(controller) {
          const send = (event: BackendExecEvent): void => {
            if (!cancelled) controller.enqueue(event);
          };

          child.stdout.on("data", (data: Buffer) => {
            send({ name: "stdout", data: new Uint8Array(data) });
          });
          child.stderr.on("data", (data: Buffer) => {
            send({ name: "stderr", data: new Uint8Array(data) });
          });
          child.on("close", (code) => {
            send({ name: "exit", exitCode: code ?? 137 });

            if (!cancelled) controller.close();
          });
        },
        cancel() {
          cancelled = true;
        },
      });

      const reader = events.getReader();

      return Promise.resolve({
        reader: { read: () => reader.read(), cancel: () => reader.cancel() },
        kill: () => {
          try {
            process.kill(-(child.pid ?? 0), "SIGKILL");
          } catch {
            // The group already exited.
          }

          return Promise.resolve();
        },
      });
    },
  };
}

/**
 * The real `ProjectRpcTarget` over a fresh temporary directory and `/bin/sh`, with the env's cwd in
 * a project directory below the workspace root, as a project conversation's is.
 */
export async function withHostWorkspace(use: (env: ExecutionEnv) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "computer-env-"));

  try {
    await mkdir(join(root, "project"));

    const target = new ProjectRpcTarget(
      hostFilesystemProvider(root),
      new FakeProjectTransactions(),
      hostExecBackend(root),
    );

    await use(createComputerEnv({ cwd: "/workspace/project", target }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
