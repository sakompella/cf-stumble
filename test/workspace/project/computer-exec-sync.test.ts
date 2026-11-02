import { Workspace, type WorkspaceBackend } from "@cloudflare/computer";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import {
  computerExecBackend,
  computerFilesystemProvider,
  durableObjectTransactions,
} from "../../../src/workspace/project/computer-adapter.js";
import { ProjectRpcTarget } from "../../../src/workspace/project/target.js";
import { computerStorage } from "../../../src/workspace/workspace-platform.js";

type Connection = Awaited<ReturnType<WorkspaceBackend["connect"]>>;

type SyncRpc = Connection["rpc"]["sync"];

const GENERATED_REV = 100;

function closed<T>(...chunks: T[]): ReadableStream<T> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

class ContainerThatCreatesAFile {
  pulls = 0;
  #executed = false;
  #pushRev = 0;

  readonly backend: WorkspaceBackend = {
    id: "container-shell",
    type: "fake-container",
    connect: () => Promise.resolve(this.#connection()),
  };

  #rev(): number {
    return this.#executed ? GENERATED_REV : 0;
  }

  #connection(): Connection {
    return {
      runtimeId: "fake-runtime",
      sync: "remote",
      close: async () => {},
      rpc: {
        shell: {
          exec: () => {
            this.#executed = true;

            return Promise.resolve({
              id: "exec",
              events: closed({ id: "exec", seq: 0, name: "exit" as const, code: 0 }),
            });
          },
          getExec: () => Promise.reject(new Error("unused")),
          killExec: async () => {},
          disposeExec: async () => {},
        },
        sync: this.#sync(),
      },
    };
  }

  #sync(): SyncRpc {
    return {
      push: async ({ senderRev, changes }) => {
        for await (const _ of changes);
        this.#pushRev = senderRev;

        return { rev: this.#rev(), appliedPushCursor: { rev: senderRev, path: null } };
      },
      fetchChanges: () => {
        this.pulls += 1;

        return Promise.resolve({
          currentCursor: { rev: this.#rev(), path: null },
          appliedPushCursor: { rev: this.#pushRev, path: null },
          stream: this.#executed
            ? closed({
                kind: "file" as const,
                rev: GENERATED_REV,
                path: "/workspace/generated.txt",
                mode: 0o644,
                mtime: 1,
                size: 0,
                chunks: [],
              })
            : closed(),
        });
      },
      watermarks: () =>
        Promise.resolve({
          currentRev: this.#rev(),
          pushRev: this.#pushRev,
          fetchCursor: { rev: 0, path: null },
        }),
      readEntry: () => Promise.resolve(null),
      hasObjects: () => Promise.resolve([]),
      fetchObjects: () => closed(),
      pushObjects: async (objects) => {
        for await (const _ of objects);
      },
    };
  }
}

test("a file a command creates is readable once the command has exited", async () => {
  await runInDurableObject(env.SUPERVISOR.getByName("exec-sync"), async (_instance, state) => {
    const container = new ContainerThatCreatesAFile();

    const workspace = new Workspace({
      storage: computerStorage(state.storage),
      backends: [container.backend],
    });

    await workspace.fs.mkdir("/workspace", { recursive: true });

    const target = new ProjectRpcTarget(
      computerFilesystemProvider(workspace),
      durableObjectTransactions(state.storage),
      computerExecBackend(workspace),
    );

    const started = await target.startExec({ command: "touch /workspace/generated.txt" });

    if (!started.ok) throw new Error(JSON.stringify(started));

    for await (const _ of started.value.events);

    expect(container.pulls).toBeGreaterThan(0);
    expect(await target.readFile("/generated.txt")).toMatchObject({ ok: true });
  });
});
