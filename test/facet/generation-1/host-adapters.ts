import { devShellTool } from "../../dev-shell-tool.js";
import { spawn } from "node:child_process";
import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  writeSync,
} from "node:fs";
import type { BackendExecEvent, ExecBackend } from "../../../src/workspace/project/exec-backend.js";
import type { ProjectFilesystemProvider } from "../../../src/workspace/project/provider.js";
import { WORKSPACE_ROOT } from "../../../src/workspace-layout.js";

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
    openSync: (path, flags) => openSync(hostPath(root, path), flags),
    writeSync: (fd, buffer) => writeSync(fd, buffer),
    closeSync: (fd) => {
      closeSync(fd);
    },
    readFileSync: (path) => new Uint8Array(readFileSync(hostPath(root, path))),
  };
}

export function hostExecBackend(root: string): ExecBackend {
  return {
    exec(input) {
      const child = spawn(devShellTool("dash"), ["-c", input.command], {
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
          } catch {}

          return Promise.resolve();
        },
        backend: "container",
      });
    },
  };
}
