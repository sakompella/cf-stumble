import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  computerExecBackend,
  type ExecWorkspace,
} from "../../../src/workspace/project/computer-adapter.js";
import { CONTAINER_BACKEND_ID } from "../../../src/workspace/project/exec-backend.js";

function alive(pid: number | undefined): boolean {
  if (pid === undefined) return false;

  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
}

async function until(deadlineMs: number, reached: () => boolean): Promise<void> {
  const deadline = Date.now() + deadlineMs;

  while (!reached()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the host process tree");

    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
  }
}

function hostRuntime() {
  let child: ChildProcess | undefined;
  let exitCode = 137;
  let closed: (() => void) | undefined;

  const closedPromise = new Promise<void>((resolve) => {
    closed = resolve;
  });

  let exitSent = false;

  const runtime = {
    exec(source: string) {
      child = spawn("/bin/sh", ["-c", source], { stdio: ["ignore", "ignore", "ignore"] });
      child.on("close", (code) => {
        exitCode = code ?? 137;
        closed?.();
      });

      return Promise.resolve({
        getReader: () => ({
          read: async () => {
            if (exitSent) return { done: true };

            await closedPromise;
            exitSent = true;

            return {
              done: false,
              value: { id: "1", seq: 0, name: "exit", code: exitCode },
            };
          },
          cancel: () => Promise.resolve(),
        }),
        kill: () => {
          child?.kill("SIGTERM");

          return Promise.resolve();
        },
      });
    },
  } satisfies ExecWorkspace["runtime"];

  return { runtime, root: () => child };
}

test("cancelling a running command kills the wrapper, its command and the command's child", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cf-stumble-process-group-"));
  const pidFile = join(directory, "pids");
  const command = `printf '%s\\n' $$ > ${pidFile}; sleep 60 & printf '%s\\n' $! >> ${pidFile}; wait`;
  const { runtime, root } = hostRuntime();
  const backend = computerExecBackend({ runtime }, CONTAINER_BACKEND_ID, null);

  try {
    const handle = await backend.exec({ command, cwd: "/", timeoutMs: 30_000 });

    await until(5_000, () => {
      if (!existsSync(pidFile)) return false;

      return readFileSync(pidFile, "utf8").trim().split("\n").length === 2;
    });

    const [commandPid, childPid] = readFileSync(pidFile, "utf8").trim().split("\n").map(Number);
    const rootPid = root()?.pid;

    expect(alive(rootPid), "the session leader is running").toBe(true);
    expect(alive(commandPid), "the command is running").toBe(true);
    expect(alive(childPid), "the command's child is running").toBe(true);

    await handle.kill();

    await until(5_000, () => ![rootPid, commandPid, childPid].some(alive));

    expect(alive(rootPid), "the session leader is gone").toBe(false);
    expect(alive(commandPid), "the command is gone").toBe(false);
    expect(alive(childPid), "the command's child is gone").toBe(false);
    await expect(handle.reader.read()).resolves.toMatchObject({ value: { name: "exit" } });
  } finally {
    const rootPid = root()?.pid;

    if (rootPid !== undefined) {
      try {
        process.kill(-rootPid, "SIGKILL");
      } catch {}
    }

    rmSync(directory, { recursive: true, force: true });
  }
});
