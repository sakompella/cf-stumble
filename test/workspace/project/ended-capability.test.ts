import { afterEach, expect, test, vi } from "vitest";
import { ProjectRpcTarget } from "../../../src/workspace/project/index.js";
import type { ProjectResult } from "../../../src/workspace/project/protocol.js";
import { encode } from "./target-helpers.js";
import {
  FakeExecBackend,
  FakeProjectFilesystemProvider,
  FakeProjectTransactions,
} from "./fakes.js";

type Call = (target: ProjectRpcTarget) => Promise<ProjectResult<unknown>>;

const CAPABILITY_CALLS = {
  lstat: (target) => target.lstat("/kept.txt"),
  readFile: (target) => target.readFile("/kept.txt"),
  writeFile: (target) => target.writeFile("/after-the-turn.txt", encode("late"), "overwrite"),
  startExec: (target) => target.startExec({ command: "echo late" }),
} satisfies Record<string, Call>;

const LATE_CALLS = {
  ...CAPABILITY_CALLS,
  "startExec with an empty command": (target) => target.startExec({ command: "" }),
} satisfies Record<string, Call>;

const CLEANUP_METHODS = ["kill", "endTurn"];

function liveTarget(remainingMs: number) {
  const provider = new FakeProjectFilesystemProvider();
  provider.addFile("/workspace/kept.txt", encode("kept"));
  const execBackend = new FakeExecBackend();
  const touches = { count: 0 };

  const activity = {
    begin: () => () => {},
    touch: () => {
      touches.count += 1;
    },
  };

  const target = new ProjectRpcTarget(provider, new FakeProjectTransactions(), execBackend, {
    remainingMs,
    activity,
  });

  return { provider, execBackend, target, touches };
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

test("cleanup calls still answer after the turn has ended", async () => {
  const { target } = liveTarget(60_000);
  await target.endTurn();

  await expect(target.kill("00000000-0000-0000-0000-000000000000:0")).resolves.toEqual({
    ok: true,
    value: null,
  });
  await expect(target.endTurn()).resolves.toEqual({ ok: true, value: { killed: 0 } });
});
