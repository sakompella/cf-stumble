import { Workspace, type WorkspaceBackend } from "@cloudflare/computer";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { CONTAINER_BACKEND_ID } from "../../../src/workspace/project/exec-backend.js";
import { computerStorage } from "../../../src/workspace/workspace-platform.js";
import { WORKSPACE_OUTPUT_OPTIONS } from "../../../infra/worker-settings.js";
import { computerTarget } from "./computer-target.js";

type Connection = Awaited<ReturnType<WorkspaceBackend["connect"]>>;

type ComputerExecEvent =
  Awaited<ReturnType<Connection["rpc"]["shell"]["exec"]>>["events"] extends ReadableStream<infer E>
    ? E
    : never;

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

export function chunkLines(lines: readonly string[], perChunk: number): readonly string[] {
  const chunks: string[] = [];

  for (let start = 0; start < lines.length; start += perChunk) {
    chunks.push(lines.slice(start, start + perChunk).join(""));
  }

  return chunks;
}

export function inWorkspace<T>(
  stdout: readonly string[],
  use: (workspace: Workspace, target: ReturnType<typeof computerTarget>) => Promise<T>,
): Promise<T> {
  return runInDurableObject(
    env.SUPERVISOR.getByName("exec-output-limits"),
    async (_instance, state): Promise<T> => {
      const container = new ContainerThatEchoes(stdout);

      const workspace = new Workspace({
        storage: computerStorage(state.storage),
        backends: [container.backend],
        output: WORKSPACE_OUTPUT_OPTIONS,
      });

      await workspace.fs.mkdir("/workspace/project", { recursive: true });

      return use(workspace, computerTarget(workspace, state.storage));
    },
  );
}
