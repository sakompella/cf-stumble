import { expect, test, vi } from "vitest";
import { isolateWithContainerFallback } from "../../../src/workspace/project/exec-fallback.js";
import { startExecOperation } from "../../../src/workspace/project/exec-operation.js";
import type {
  BackendExecEvent,
  ExecBackend,
  ExecBackendInput,
} from "../../../src/workspace/project/exec-backend.js";

const encoder = new TextEncoder();

function scripted(events: readonly BackendExecEvent[], seen: ExecBackendInput[]): ExecBackend {
  return {
    exec(input) {
      seen.push(input);
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
      });
    },
  };
}

const out = (text: string): BackendExecEvent => ({ name: "stdout", data: encoder.encode(text) });

const err = (text: string): BackendExecEvent => ({ name: "stderr", data: encoder.encode(text) });

const exit = (exitCode: number): BackendExecEvent => ({ name: "exit", exitCode });

async function run(isolateEvents: BackendExecEvent[], containerEvents: BackendExecEvent[]) {
  const isolateSeen: ExecBackendInput[] = [];
  const containerSeen: ExecBackendInput[] = [];

  const backend = isolateWithContainerFallback(
    scripted(isolateEvents, isolateSeen),
    scripted(containerEvents, containerSeen),
  );

  const operation = startExecOperation(
    backend,
    { command: "grep foo file", cwd: "/", timeoutMs: 1_000 },
    () => {},
  );

  const reader = operation.events.getReader();
  const decoder = new TextDecoder();
  let text = "";

  for (let read = await reader.read(); !read.done; read = await reader.read()) {
    text += decoder.decode(read.value);
  }

  return { text, containerRuns: containerSeen };
}

test.each([127, 129])("an isolate exit %i reruns the command in the container", async (code) => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});

  const { text, containerRuns } = await run(
    [err("git branch: unknown option '-vv'\n"), exit(code)],
    [out("* main\n"), exit(0)],
  );

  expect(containerRuns).toEqual([expect.objectContaining({ backend: "container" })]);
  expect(text).toContain("* main");
  expect(text).not.toContain("unknown option");
  expect(log).toHaveBeenCalledWith(
    expect.objectContaining({ event: "exec.finished", exitCode: 0, fellBackFrom: "isolate" }),
  );
});

test("an isolate failure that ran something is returned as it is", async () => {
  const { text, containerRuns } = await run([exit(1)], [out("never\n"), exit(0)]);

  expect(containerRuns).toEqual([]);
  expect(text).toContain('"exitCode":1');
});

test("exit 129 after output is not rerun", async () => {
  const { text, containerRuns } = await run([out("a\n"), err("usage\n"), exit(129)], []);

  expect(containerRuns).toEqual([]);
  expect(text).toContain("usage");
});
