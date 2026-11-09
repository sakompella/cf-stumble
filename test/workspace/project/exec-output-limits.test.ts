import { Workspace, type WorkspaceBackend } from "@cloudflare/computer";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import {
  computerExecBackend,
  computerFilesystemProvider,
  durableObjectTransactions,
} from "../../../src/workspace/project/computer-adapter.js";
import { CONTAINER_BACKEND_ID } from "../../../src/workspace/project/exec-backend.js";
import { ProjectRpcTarget } from "../../../src/workspace/project/target.js";
import { computerStorage } from "../../../src/workspace/workspace-platform.js";
import { WORKSPACE_OUTPUT_OPTIONS } from "../../../infra/worker-settings.js";
import { withDecodedEvents, type ExecEvent } from "./decoded-events.js";

type Connection = Awaited<ReturnType<WorkspaceBackend["connect"]>>;

type ComputerExecEvent =
  Awaited<ReturnType<Connection["rpc"]["shell"]["exec"]>>["events"] extends ReadableStream<infer E>
    ? E
    : never;

type Exited = Extract<ExecEvent, { outcome: "exited" }>;

type Run = Readonly<{ events: ExecEvent[]; workspace: Workspace; saved: string | undefined }>;

function closed<T>(...chunks: T[]): ReadableStream<T> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

class ContainerThatEchoes {
  readonly backend: WorkspaceBackend = {
    id: CONTAINER_BACKEND_ID,
    type: "fake-container",
    connect: () => Promise.resolve(this.#connection()),
  };

  #stdout: readonly string[];

  constructor(stdout: readonly string[]) {
    this.#stdout = stdout;
  }

  #connection(): Connection {
    const events: ComputerExecEvent[] = this.#stdout.map((chunk, index) => ({
      id: "exec",
      seq: index,
      name: "stdout",
      value: new TextEncoder().encode(chunk),
    }));

    events.push({ id: "exec", seq: events.length, name: "exit", code: 0 });

    return {
      runtimeId: "fake-runtime",
      sync: "remote",
      close: async () => {},
      rpc: {
        shell: {
          exec: () => Promise.resolve({ id: "exec", events: closed(...events) }),
          getExec: () => Promise.reject(new Error("unused")),
          killExec: async () => {},
          disposeExec: async () => {},
        },
        sync: {
          push: ({ senderRev }: { senderRev: number }) =>
            Promise.resolve({ rev: senderRev, appliedPushCursor: { rev: senderRev, path: null } }),
          fetchChanges: () =>
            Promise.resolve({
              currentCursor: { rev: 0, path: null },
              appliedPushCursor: { rev: 0, path: null },
              stream: closed(),
            }),
          watermarks: () =>
            Promise.resolve({ currentRev: 0, pushRev: 0, fetchCursor: { rev: 0, path: null } }),
          readEntry: () => Promise.resolve(null),
          hasObjects: () => Promise.resolve([]),
          fetchObjects: () => closed(),
          pushObjects: async () => {},
        },
      },
    };
  }
}

function chunkLines(lines: readonly string[], perChunk: number): readonly string[] {
  const chunks: string[] = [];

  for (let start = 0; start < lines.length; start += perChunk) {
    chunks.push(lines.slice(start, start + perChunk).join(""));
  }

  return chunks;
}

function runEcho(stdout: readonly string[]): Promise<Run> {
  return runInDurableObject(
    env.SUPERVISOR.getByName("exec-output-limits"),
    async (_instance, state): Promise<Run> => {
      const container = new ContainerThatEchoes(stdout);

      const workspace = new Workspace({
        storage: computerStorage(state.storage),
        backends: [container.backend],
        output: WORKSPACE_OUTPUT_OPTIONS,
      });

      await workspace.fs.mkdir("/workspace", { recursive: true });

      const target = withDecodedEvents(
        new ProjectRpcTarget(
          computerFilesystemProvider(workspace),
          durableObjectTransactions(state.storage),
          computerExecBackend(workspace, CONTAINER_BACKEND_ID, { generation: 0 }),
        ),
      );

      const started = await target.startExec({ command: "echo" });

      if (!started.ok) throw new Error(JSON.stringify(started));

      const events: ExecEvent[] = [];

      for await (const event of started.value.events) events.push(event);

      const terminal = events.at(-1);

      const path =
        terminal?.kind === "terminal" && terminal.outcome === "exited"
          ? terminal.fullOutputPaths?.[0]
          : undefined;

      const saved = path === undefined ? undefined : await workspace.fs.readFile(path, "utf8");

      return { events, workspace, saved };
    },
  );
}

function exitedTerminal(events: readonly ExecEvent[]): Exited | undefined {
  const terminal = events.at(-1);

  return terminal?.kind === "terminal" && terminal.outcome === "exited" ? terminal : undefined;
}

function stdoutOf(events: readonly ExecEvent[]): string {
  return events.flatMap((event) => (event.kind === "stdout" ? [event.data] : [])).join("");
}

test("output past the limits is cut and the full output is saved in the workspace", async () => {
  const lines = Array.from({ length: 3_000 }, (_, index) => `line-${index}\n`);
  const { events, saved } = await runEcho(chunkLines(lines, 100));

  const terminal = exitedTerminal(events);

  expect(terminal).toMatchObject({ kind: "terminal", outcome: "exited", exitCode: 0 });
  expect(terminal?.fullOutputPaths).toEqual([
    expect.stringMatching(/^\/\.cf-stumble\/output\/.+\.stdout\.log$/u),
  ]);

  expect(stdoutOf(events)).toBe(lines.join(""));

  expect(saved).toBe(lines.join(""));
});

test("output that fits the limits is delivered whole and saves nothing", async () => {
  const { events, workspace, saved } = await runEcho(["hello\n", "world\n"]);

  const terminal = exitedTerminal(events);

  expect(terminal).toMatchObject({ kind: "terminal", outcome: "exited", exitCode: 0 });
  expect(terminal?.fullOutputPaths).toBeUndefined();
  expect(stdoutOf(events)).toBe("hello\nworld\n");
  expect(saved).toBeUndefined();

  await expect(workspace.fs.readdir(WORKSPACE_OUTPUT_OPTIONS.dir)).rejects.toThrow();
});
