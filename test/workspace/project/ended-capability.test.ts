import { afterEach, expect, test, vi } from "vitest";
import { ProjectRpcTarget } from "../../../src/workspace/project/index.js";
import type { ProjectResult } from "../../../src/workspace/project/protocol.js";
import { encode } from "./target-helpers.js";
import {
  FakeExecBackend,
  FakeProjectFilesystemProvider,
  FakeProjectTransactions,
} from "./fakes.js";

/**
 * An ended turn's capability is spent: whoever still holds a duplicate of it, every method that
 * reads, writes, or runs something in the workspace answers `turn-ended`, and only the two cleanup
 * methods still answer as they always do.
 */

type Call = (target: ProjectRpcTarget) => Promise<ProjectResult<unknown>>;

const CAPABILITY_CALLS = {
  lstat: (target) => target.lstat("/kept.txt"),
  readFile: (target) => target.readFile("/kept.txt"),
  writeFile: (target) => target.writeFile("/after-the-turn.txt", encode("late"), "overwrite"),
  listFiles: (target) => target.listFiles("/"),
  startExec: (target) => target.startExec({ command: "echo late" }),
} satisfies Record<string, Call>;

/** What a duplicate may still send once the turn is over, including input that does not parse. */
const LATE_CALLS = {
  ...CAPABILITY_CALLS,
  "startExec with malformed input": (target) => target.startExec({ command: 42 }),
} satisfies Record<string, Call>;

const CLEANUP_METHODS = ["kill", "endTurn"];

const FILE_METHODS = ["lstat", "readFile", "writeFile", "listFiles"] as const;

function liveTarget(remainingMs: number) {
  const provider = new FakeProjectFilesystemProvider();
  provider.addFile("/workspace/kept.txt", encode("kept"));
  const execBackend = new FakeExecBackend();
  const containerState = { generation: 0 };
  const touches = { count: 0 };

  const activity = {
    begin: () => () => {},
    touch: () => {
      touches.count += 1;
    },
  };

  const target = new ProjectRpcTarget(provider, new FakeProjectTransactions(), execBackend, {
    remainingMs,
    containerState,
    activity,
  });

  return { provider, execBackend, containerState, target, touches };
}

afterEach(() => {
  vi.useRealTimers();
});

test("every method is either a capability call or a cleanup call", () => {
  const methods = Object.getOwnPropertyNames(ProjectRpcTarget.prototype).filter(
    (name) => name !== "constructor",
  );

  expect(methods.toSorted()).toEqual(
    [...Object.keys(CAPABILITY_CALLS), ...CLEANUP_METHODS].toSorted(),
  );
});

test.each(Object.entries(CAPABILITY_CALLS))(
  "%s works while the turn is live",
  async (_name, call) => {
    const { target } = liveTarget(60_000);

    await expect(call(target)).resolves.toMatchObject({ ok: true });
  },
);

test.each(Object.entries(LATE_CALLS))(
  "%s answers turn-ended after endTurn, touching nothing",
  async (_name, call) => {
    const { provider, execBackend, target, touches } = liveTarget(60_000);
    await target.endTurn();

    await expect(call(target)).resolves.toEqual({ ok: false, error: { code: "turn-ended" } });
    expect(provider.nodes.has("/workspace/after-the-turn.txt")).toBe(false);
    expect(execBackend.requests).toEqual([]);
    expect(touches.count).toBe(0);
  },
);

test.each(Object.entries(LATE_CALLS))(
  "%s answers turn-ended once the turn's budget has passed, touching nothing",
  async (_name, call) => {
    vi.useFakeTimers();
    const { provider, execBackend, target, touches } = liveTarget(1_000);
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(call(target)).resolves.toEqual({ ok: false, error: { code: "turn-ended" } });
    expect(provider.nodes.has("/workspace/after-the-turn.txt")).toBe(false);
    expect(execBackend.requests).toEqual([]);
    expect(touches.count).toBe(0);
  },
);

test.each(Object.entries(LATE_CALLS))(
  "%s answers turn-ended, not container-restarted, after a container replacement",
  async (_name, call) => {
    const { execBackend, containerState, target, touches } = liveTarget(60_000);
    await target.endTurn();
    containerState.generation += 1;

    await expect(call(target)).resolves.toEqual({ ok: false, error: { code: "turn-ended" } });
    expect(execBackend.requests).toEqual([]);
    expect(touches.count).toBe(0);
  },
);

test("cleanup calls still answer after the turn has ended", async () => {
  const { target } = liveTarget(60_000);
  await target.endTurn();

  await expect(target.kill("00000000-0000-0000-0000-000000000000:0")).resolves.toEqual({
    ok: true,
    value: null,
  });
  await expect(target.endTurn()).resolves.toEqual({ ok: true, value: { killed: 0 } });
});

test("a container replacement still does not refuse file access", async () => {
  const containerState = { generation: 0 };
  const provider = new FakeProjectFilesystemProvider();
  provider.addFile("/workspace/kept.txt", encode("kept"));

  const target = new ProjectRpcTarget(
    provider,
    new FakeProjectTransactions(),
    new FakeExecBackend(),
    {
      remainingMs: 60_000,
      containerState,
    },
  );

  containerState.generation = 1;

  for (const name of FILE_METHODS) {
    await expect(CAPABILITY_CALLS[name](target)).resolves.toMatchObject({ ok: true });
  }
});
