import { expect, test, vi } from "vitest";
import type {
  BackendExecEvent,
  ExecBackend,
  ExecBackendHandle,
  ExecBackendInput,
} from "../../../src/workspace/project/exec-backend.js";
import { isolateWithContainerFallback } from "../../../src/workspace/project/exec-fallback.js";
import { startExecOperation } from "../../../src/workspace/project/exec-operation.js";

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

async function run(isolateEvents: BackendExecEvent[], containerEvents: BackendExecEvent[]) {
  const container = new ScriptedBackend("container", containerEvents);

  const backend = isolateWithContainerFallback(
    new ScriptedBackend("isolate", isolateEvents),
    container,
  );

  const handle = await backend.exec({ command: "grep foo file", cwd: "/", timeoutMs: 1_000 });

  const text = await drain(
    startExecOperation(
      { exec: () => Promise.resolve(handle) },
      { command: "grep foo file", cwd: "/", timeoutMs: 1_000 },
      () => {},
    ).events,
  );

  return { text, containerRuns: container.seen, handle };
}

test.each([127, 129])("an isolate exit %i reruns the command in the container", async (code) => {
  vi.spyOn(console, "log").mockImplementation(() => {});

  const { text, containerRuns, handle } = await run(
    [err("git branch: unknown option '-vv'\n"), exit(code)],
    [out("* main\n"), exit(0)],
  );

  expect(containerRuns).toEqual([
    expect.objectContaining({
      backend: "container",
      command: "export CF_STUMBLE_GIT_FALLBACK=1; grep foo file",
    }),
  ]);
  expect(text).toContain("* main");
  expect(text).not.toContain("unknown option");
  expect(handle.backend).toBe("container");
  expect(handle.fellBackFrom).toBe("isolate");
});

test("an isolate that hits a just-bash limit reruns the command in the container", async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});

  const { text, containerRuns, handle } = await run(
    [err("bash: seq: iteration limit exceeded (100000)\n"), exit(126)],
    [out("1\n2\n3\n"), exit(0)],
  );

  expect(containerRuns).toEqual([
    expect.objectContaining({
      backend: "container",
      command: "export CF_STUMBLE_GIT_FALLBACK=1; grep foo file",
    }),
  ]);
  expect(text).toContain("1\\n2\\n3");
  expect(text).not.toContain("iteration limit exceeded");
  expect(handle.backend).toBe("container");
  expect(handle.fellBackFrom).toBe("isolate");
});

test("an isolate that exceeds its execution deadline reruns the command in the container", async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});

  const { text, containerRuns, handle } = await run(
    [err("bash: grep exceeded execution deadline (30000ms)\n"), exit(124)],
    [out("found\n"), exit(0)],
  );

  expect(containerRuns).toHaveLength(1);
  expect(text).toContain("found\\n");
  expect(text).not.toContain("execution deadline");
  expect(handle.fellBackFrom).toBe("isolate");
});

test("an isolate permission failure does not rerun in the container", async () => {
  const { text, containerRuns } = await run(
    [err("bash: ./script.sh: Permission denied\n"), exit(126)],
    [out("never\n"), exit(0)],
  );

  expect(containerRuns).toEqual([]);
  expect(text).toContain("Permission denied");
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

test("an isolate stream that ends without an exit still delivers its stderr", async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});

  const { text, containerRuns } = await run([err("partial failure\n")], []);

  expect(containerRuns).toEqual([]);
  expect(text).toContain("partial failure");
});

test("a kill while the container fallback starts kills that container once it exists", async () => {
  const started = gate();

  const container = new ScriptedBackend("container", [out("late\n"), exit(0)], {
    exec: started.opened,
  });

  const handle = await isolateWithContainerFallback(
    new ScriptedBackend("isolate", [exit(127)]),
    container,
  ).exec({ command: "git branch -vv", cwd: "/", timeoutMs: 1_000 });

  const reading = handle.reader.read().catch(() => {});
  await vi.waitFor(() => {
    expect(container.seen).toHaveLength(1);
  });
  await handle.reader.cancel();
  await handle.kill();
  started.open();
  await reading;

  await vi.waitFor(() => {
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
