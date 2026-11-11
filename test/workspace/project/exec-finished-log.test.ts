import { expect, test, vi } from "vitest";
import type {
  BackendExecEvent,
  ExecBackend,
  ExecBackendHandle,
} from "../../../src/workspace/project/exec-backend.js";
import type { LogFields } from "../../../src/diagnostics.js";
import { isolateWithContainerFallback } from "../../../src/workspace/project/exec-fallback.js";
import { startExecOperation } from "../../../src/workspace/project/exec-operation.js";

const encoder = new TextEncoder();

const err = (text: string): BackendExecEvent => ({ name: "stderr", data: encoder.encode(text) });

const exit = (exitCode: number): BackendExecEvent => ({ name: "exit", exitCode });

function scripted(backend: "isolate" | "container", events: readonly BackendExecEvent[]) {
  return {
    exec: (): Promise<ExecBackendHandle> => {
      const queue = [...events];

      return Promise.resolve({
        reader: {
          read: () => {
            const value = queue.shift();

            return Promise.resolve(value === undefined ? { done: true } : { done: false, value });
          },
          cancel: () => Promise.resolve(),
        },
        kill: () => Promise.resolve(),
        backend,
      });
    },
  } satisfies ExecBackend;
}

async function finished(backend: ExecBackend, command: string): Promise<LogFields | undefined> {
  const entries: LogFields[] = [];

  vi.spyOn(console, "log").mockImplementation((entry: LogFields) => {
    entries.push(entry);
  });

  const input = { command, cwd: "/", timeoutMs: 1_000 };
  const reader = startExecOperation(backend, input, () => {}).events.getReader();

  while (!(await reader.read()).done);

  return entries.find((entry) => entry.event === "exec.finished");
}

const COMMIT = "git commit -m 'deploy key ghp_0123456789abcdefghijklmnopqrstuvwxyzAB'";

test("an isolate refusal whose container fallback refuses the write form is logged as both", async () => {
  const backend = isolateWithContainerFallback(
    scripted("isolate", [err("git commit: unsupported option\n"), exit(129)]),
    scripted("container", [
      err("git commit: the workspace git does not support this form. Use another form.\n"),
      exit(1),
    ]),
  );

  const entry = await finished(backend, COMMIT);

  expect(entry).toMatchObject({
    program: "git commit",
    backend: "container",
    fellBackFrom: "isolate",
    isolateRefused: true,
    writeFormRefused: true,
  });
  expect(JSON.stringify(entry)).not.toContain("ghp_");
});

test("a git command the isolate runs is logged without refusals", async () => {
  const entry = await finished(scripted("isolate", [exit(0)]), "git status --short");

  expect(entry).toMatchObject({
    program: "git status",
    backend: "isolate",
    fellBackFrom: null,
    isolateRefused: false,
    writeFormRefused: false,
  });
});

test("a forced isolate run that exits 129 is logged as refused", async () => {
  const entry = await finished(scripted("isolate", [exit(129)]), "git rebase -i main");

  expect(entry).toMatchObject({ program: "git rebase", isolateRefused: true });
});
