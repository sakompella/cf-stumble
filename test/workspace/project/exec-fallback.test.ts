import { expect, test } from "vitest";
import type {
  BackendExecEvent,
  ExecBackend,
  ExecBackendHandle,
  ExecBackendInput,
} from "../../../src/workspace/project/exec-backend.js";
import { isolateWithContainerFallback } from "../../../src/workspace/project/exec-fallback.js";
import { startExecOperation } from "../../../src/workspace/project/exec-operation.js";
import { eventually } from "../../eventually.js";

const encoder = new TextEncoder();

const out = (text: string): BackendExecEvent => ({ name: "stdout", data: encoder.encode(text) });

const err = (text: string): BackendExecEvent => ({ name: "stderr", data: encoder.encode(text) });

const exit = (exitCode: number): BackendExecEvent => ({ name: "exit", exitCode });

type Gates = Readonly<{ exec?: Promise<void>; read?: Promise<void> }>;

class ScriptedBackend implements ExecBackend {
  readonly seen: ExecBackendInput[] = [];
  killed = 0;
  readonly #backend: "isolate" | "container";
  readonly #events: readonly BackendExecEvent[];
  readonly #gates: Gates;

  constructor(
    backend: "isolate" | "container",
    events: readonly BackendExecEvent[],
    gates: Gates = {},
  ) {
    this.#backend = backend;
    this.#events = events;
    this.#gates = gates;
  }

  async exec(input: ExecBackendInput): Promise<ExecBackendHandle> {
    this.seen.push(input);
    await this.#gates.exec;
    const queue = [...this.#events];

    return {
      reader: {
        read: async () => {
          await this.#gates.read;
          const value = queue.shift();

          return value === undefined ? { done: true } : { done: false, value };
        },
        cancel: () => Promise.resolve(),
      },
      kill: () => {
        this.killed += 1;

        return Promise.resolve();
      },
      backend: this.#backend,
    };
  }
}

function gate() {
  const release = { open: (): void => {} };

  const opened = new Promise<void>((resolve) => {
    release.open = resolve;
  });

  return {
    opened,
    open: () => {
      release.open();
    },
  };
}

async function drain(events: ReadableStream<Uint8Array>): Promise<string> {
  const reader = events.getReader();
  const decoder = new TextDecoder();
  let text = "";

  for (let read = await reader.read(); !read.done; read = await reader.read()) {
    text += decoder.decode(read.value);
  }

  return text;
}

interface BreakingIsolate {
  readonly backend: ExecBackend;
  readonly killed: () => number;
}

function breaking(): BreakingIsolate {
  const scripted = new ScriptedBackend("isolate", []);

  return {
    backend: {
      exec: async (input) => {
        const handle = await scripted.exec(input);

        return {
          ...handle,
          reader: { ...handle.reader, read: () => Promise.reject(new Error("CPU time limit")) },
        };
      },
    },
    killed: () => scripted.killed,
  };
}

async function run(isolate: ExecBackend, command = "grep foo file") {
  const container = new ScriptedBackend("container", [out("from container\n"), exit(0)]);
  const input = { command, cwd: "/", timeoutMs: 1_000 };
  const handle = await isolateWithContainerFallback(isolate, container).exec(input);

  const text = await drain(
    startExecOperation({ exec: () => Promise.resolve(handle) }, input, () => {}).events,
  );

  return { text, containerRuns: container.seen.length, handle };
}

const isolateRun = (...events: BackendExecEvent[]) => new ScriptedBackend("isolate", events);

const NOTHING_RAN: ReadonlyArray<readonly [string, readonly BackendExecEvent[]]> = [
  ["an unknown option (exit 127)", [err("git branch: unknown option '-vv'\n"), exit(127)]],
  ["a form it does not run (exit 129)", [err("git branch: unknown option '-vv'\n"), exit(129)]],
  ["a just-bash limit", [err("bash: seq: iteration limit exceeded (100000)\n"), exit(126)]],
  [
    "its execution deadline",
    [err("bash: grep exceeded execution deadline (30000ms)\n"), exit(124)],
  ],
  ["a stream end without an exit", [err("partial failure\n")]],
];

test.each(NOTHING_RAN)(
  "an isolate run that hit %s before any output reruns in the container and shows only the container's output",
  async (_case, events) => {
    const { text, containerRuns, handle } = await run(isolateRun(...events));

    expect(containerRuns).toBe(1);
    expect(text).toContain("from container");
    expect(text).not.toContain('"stderr"');
    expect(handle.backend).toBe("container");
    expect(handle.fellBackFrom).toBe("isolate");
  },
);

const RAN: ReadonlyArray<readonly [string, readonly BackendExecEvent[], readonly string[]]> = [
  [
    "a permission failure",
    [err("bash: ./script.sh: Permission denied\n"), exit(126)],
    ["Permission denied"],
  ],
  ["a failing command", [exit(1)], ['"exitCode":1']],
  ["exit 129 after output", [out("a\n"), err("usage\n"), exit(129)], ["usage"]],
  ["a stream end after output", [out("a\n")], ["a\\n", "backend-unavailable"]],
];

test.each(RAN)("an isolate run with %s is returned as it is", async (_case, events, shown) => {
  const { text, containerRuns, handle } = await run(isolateRun(...events));

  expect(containerRuns).toBe(0);

  for (const fragment of shown) expect(text).toContain(fragment);
  expect(text).not.toContain("from container");
  expect(handle.fellBackFrom).toBeUndefined();
});

const WRITES: ReadonlyArray<readonly [string, readonly BackendExecEvent[], string]> = [
  [
    "sed -i s/a/b/ file",
    [err("bash: sed: iteration limit exceeded (100000)\n"), exit(126)],
    "iteration limit exceeded",
  ],
  [
    "grep foo file >> log",
    [err("bash: grep exceeded execution deadline (30000ms)\n"), exit(124)],
    "exceeded execution deadline",
  ],
  ["rm -rf build", [err("partial failure\n")], "partial failure"],
  [
    "yq -i '.version = 2' config.yaml",
    [err("bash: yq: iteration limit exceeded (100000)\n"), exit(126)],
    "iteration limit exceeded",
  ],
  [
    "sort -o sorted.txt words.txt",
    [err("bash: sort: iteration limit exceeded (100000)\n"), exit(126)],
    "iteration limit exceeded",
  ],
  [
    `awk '{ print > "out.txt" }' in.txt`,
    [err("bash: awk: iteration limit exceeded (100000)\n"), exit(126)],
    "iteration limit exceeded",
  ],
  [
    "curl -o page.html https://example.com",
    [err("bash: curl exceeded execution deadline (30000ms)\n"), exit(124)],
    "exceeded execution deadline",
  ],
  [
    "xan split -c 2 data.csv",
    [err("bash: xan: output part limit exceeded (100000)\n"), exit(126)],
    "limit exceeded",
  ],
];

test.each(WRITES)(
  "%j may write, so an isolate limit is returned with a rerun note instead of a second run",
  async (command, events, diagnostic) => {
    const { text, containerRuns, handle } = await run(isolateRun(...events), command);

    expect(containerRuns).toBe(0);
    expect(text).toContain(diagnostic);
    expect(text).toContain("rerun with backend: container");
    expect(text).toContain('"stderr"');
    expect(handle.backend).toBe("isolate");
    expect(handle.fellBackFrom).toBeUndefined();
  },
);

test.each([
  ["awk 'BEGIN{for(;;)}'", 1, "from container"],
  ["cp a b", 0, "rerun with backend: container"],
] as const)(
  "an isolate stream that breaks before any output stops the isolate; %j runs in the container %i times",
  async (command, runs, shown) => {
    const isolate = breaking();
    const { text, containerRuns } = await run(isolate.backend, command);

    expect(containerRuns).toBe(runs);
    expect(text).toContain(shown);
    expect(isolate.killed()).toBe(1);
  },
);

test("a kill while the container fallback starts kills that container once it exists", async () => {
  const started = gate();

  const container = new ScriptedBackend("container", [out("late\n"), exit(0)], {
    exec: started.opened,
  });

  const handle = await isolateWithContainerFallback(isolateRun(exit(127)), container).exec({
    command: "git branch -vv",
    cwd: "/",
    timeoutMs: 1_000,
  });

  const reading = handle.reader.read().catch(() => {});
  await eventually(() => {
    expect(container.seen).toHaveLength(1);
  });
  await handle.reader.cancel();
  await handle.kill();
  started.open();
  await reading;

  await eventually(() => {
    expect(container.killed).toBe(1);
  });
});

test("a kill during the isolate's last read starts no container", async () => {
  const lastRead = gate();
  const container = new ScriptedBackend("container", [exit(0)]);

  const handle = await isolateWithContainerFallback(
    new ScriptedBackend("isolate", [exit(127)], { read: lastRead.opened }),
    container,
  ).exec({ command: "git branch -vv", cwd: "/", timeoutMs: 1_000 });

  const reading = handle.reader.read();
  await handle.kill();
  lastRead.open();

  await expect(reading).resolves.toEqual({ done: true });
  expect(container.seen).toEqual([]);
});
