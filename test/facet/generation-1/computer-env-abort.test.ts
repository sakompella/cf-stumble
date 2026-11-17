import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { ExecutionError } from "@earendil-works/pi-durable/env";
import { expect, test } from "vitest";
import { eventually, tick } from "../../eventually.js";
import { computerEnv } from "../../../src/facet/generation-1/computer-env.js";
import type {
  ProjectResult,
  ProjectRpcTargetContract,
} from "../../../src/workspace/project/protocol.js";
import { hostWith } from "./conversation-host.js";
import { unscriptedGenerations } from "./generation-control.js";

type Started = ProjectResult<{ operationId: string; events: ReadableStream<Uint8Array> }>;

const unused = () => Promise.reject(new Error("not used"));

class SlowStartWorkspace implements ProjectRpcTargetContract, Disposable {
  readonly killed: string[] = [];
  readonly killedAfterRelease: string[] = [];
  released = false;
  #started: (started: Started) => void = () => {};
  #events: ReadableStreamDefaultController<Uint8Array> | undefined;

  lstat = unused;
  readFile = unused;
  writeFile = unused;
  endTurn = unused;

  startExec = () =>
    new Promise<Started>((resolve) => {
      this.#started = resolve;
    });

  kill = (operationId: string) => {
    if (this.released) {
      this.killedAfterRelease.push(operationId);

      return Promise.reject(new Error("RPC stub used after being disposed"));
    }

    if (this.killed.includes(operationId))
      return Promise.resolve({ ok: true, value: null } as const);

    this.killed.push(operationId);
    const terminal = { kind: "terminal", seq: 0, outcome: "killed" };
    this.#events?.enqueue(new TextEncoder().encode(`${JSON.stringify(terminal)}\n`));
    this.#events?.close();

    return Promise.resolve({ ok: true, value: null } as const);
  };

  finishStarting(operationId: string): void {
    const events = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.#events = controller;
      },
    });

    this.#started({ ok: true, value: { operationId, events } });
  }

  [Symbol.dispose](): void {
    this.released = true;
  }
}

test("an abort while a command is still starting kills it before the workspace is released", async () => {
  const workspace = new SlowStartWorkspace();
  const owner = new AbortController();
  const host = hostWith({ workspace: () => Promise.resolve(workspace) });

  const env = await computerEnv(
    host,
    unscriptedGenerations,
    "1",
    "/workspace/project",
    owner.signal,
  );

  const result = env.exec("sleep 300", {}, withAbortSignal(owner.signal, BACKGROUND_CONTEXT));

  owner.abort();
  await tick();
  workspace.finishStarting("op-1");

  await eventually(() => {
    expect(workspace.killed).toEqual(["op-1"]);
  });
  expect(await result).toEqual({ ok: false, error: new ExecutionError("aborted", "aborted") });
  expect(workspace.killedAfterRelease).toEqual([]);
});
