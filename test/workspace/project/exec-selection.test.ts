import { describe, expect, it, test, vi } from "vitest";
import {
  chosenExecBackend,
  isolateWithContainerFallback,
  routedBackend,
} from "../../../src/workspace/project/exec-selection.js";
import { startExecOperation } from "../../../src/workspace/project/exec-operation.js";
import type {
  BackendExecEvent,
  ExecBackend,
  ExecBackendInput,
} from "../../../src/workspace/project/exec-backend.js";

const ROUTES: ReadonlyArray<readonly [string, "isolate" | "container" | undefined, string]> = [
  ["ls -la", undefined, "isolate"],
  ["cat a.txt | grep foo | sort | uniq -c | head -5", undefined, "isolate"],
  ["cd src && find . -name '*.ts' | wc -l", undefined, "isolate"],
  ["grep 'a|b; c' file > out.txt 2>&1", undefined, "isolate"],
  ["jq .name package.json", undefined, "isolate"],
  ["git status", undefined, "isolate"],
  ["git status --short", undefined, "isolate"],
  ["git branch -vv", undefined, "isolate"],
  ["git stash list", undefined, "isolate"],
  ["git log --oneline | head", undefined, "isolate"],
  ["ls && git diff", undefined, "isolate"],
  ["git log", "isolate", "isolate"],
  ["git push origin main", undefined, "isolate"],
  ["git -C x status", undefined, "isolate"],
  ["git log && node --version", undefined, "container"],
  ["pnpm test", undefined, "container"],
  ["ls && pnpm test", undefined, "container"],
  ["curl https://example.com", undefined, "container"],
  ["echo $(whoami)", undefined, "container"],
  ["echo `whoami`", undefined, "container"],
  ["(cd src; ls)", undefined, "container"],
  ["PATH=/x ls", undefined, "container"],
  ["FOO=1 ls", undefined, "isolate"],
  ["LD_PRELOAD=x ls", undefined, "container"],
  ["FOO=1", undefined, "container"],
  ["./run.sh", undefined, "container"],
  ["for f in *; do cat $f; done", undefined, "container"],
  ["cat <<EOF\nhi\nEOF", undefined, "container"],
  ["find . -exec rm {} ;", undefined, "container"],
  ["xargs rm", undefined, "container"],
  ["echo 'unterminated", undefined, "container"],
  ["", undefined, "container"],
  ["ls", "container", "container"],
  ["ls", "isolate", "isolate"],
  ["git pull", "isolate", "isolate"],
  ["node -e 1 | cat", "isolate", "container"],
];

describe("routedBackend", () => {
  it.each(ROUTES)("%s (%s) goes to %s", (command, requested, expected) => {
    expect(routedBackend(command, requested)).toBe(expected);
  });
});

function recordingWorkspace(backends: string[]): Parameters<typeof chosenExecBackend>[0] {
  const exec: Parameters<typeof chosenExecBackend>[0]["runtime"]["exec"] = (_source, options) => {
    backends.push(options.backend);

    return Promise.reject(new Error("stop"));
  };

  return { runtime: { exec } };
}

describe("chosenExecBackend routing", () => {
  it("never sends a container-only command to the isolate", async () => {
    const backends: string[] = [];

    const backend = chosenExecBackend(recordingWorkspace(backends), { generation: 1 });

    for (const [command, backendChoice] of [
      ["pnpm test", "isolate"],
      ["pnpm install", undefined],
      ["ls", undefined],
      ["ls", "container"],
    ] as const) {
      await backend
        .exec({ command, cwd: "/", timeoutMs: 1, backend: backendChoice })
        .catch(() => {});
    }

    expect(backends).toEqual([
      "container-shell",
      "container-shell",
      "worker-shell",
      "container-shell",
    ]);
  });
});

const encoder = new TextEncoder();

function scripted(
  backend: "isolate" | "container",
  events: readonly BackendExecEvent[],
  seen: ExecBackendInput[],
): ExecBackend {
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
        backend,
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
    scripted("isolate", isolateEvents, isolateSeen),
    scripted("container", containerEvents, containerSeen),
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

test("after a fallback the exec log names the container as where it ran", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});

  await run([exit(127)], [out("* main\n"), exit(0)]);

  expect(log).toHaveBeenCalledWith(
    expect.objectContaining({
      event: "exec.finished",
      requested: "automatic",
      backend: "container",
      fellBackFrom: "isolate",
    }),
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
