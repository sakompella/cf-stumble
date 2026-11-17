import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { expect, test, vi } from "vitest";
import { ProjectRpcTarget } from "../../../src/workspace/project/index.js";
import type { ProjectResult } from "../../../src/workspace/project/protocol.js";
import {
  FakeExecBackend,
  FakeProjectFilesystemProvider,
  FakeProjectTransactions,
} from "./fakes.js";
import { encode, targetOptions } from "./target-helpers.js";

type Call = Readonly<{ method: string; command: string }>;

type Answer = ProjectResult<unknown>;

const CLEANUP_METHODS = ["kill", "endTurn"];

const CAPABILITY_METHODS = Object.getOwnPropertyNames(ProjectRpcTarget.prototype).filter(
  (name) => name !== "constructor" && !CLEANUP_METHODS.includes(name),
);

const call: gs.Generator<Call> = gs
  .tuples(gs.sampledFrom(CAPABILITY_METHODS), gs.sampledFrom(["echo hi", ""]))
  .map(([method, command]) => ({ method, command }));

function perform(
  target: ProjectRpcTarget,
  { method, command }: Call,
  index: number,
): Promise<Answer> {
  if (method === "lstat") return target.lstat("/kept.txt");

  if (method === "readFile") return target.readFile("/kept.txt");

  if (method === "writeFile")
    return target.writeFile(`/written-${index}.txt`, encode("x"), "overwrite");

  if (method === "startExec") return target.startExec({ command });

  throw new Error(`the turn-ended model has no call for the capability method ${method}`);
}

function liveAnswer({ method, command }: Call, liveExecs: number): string {
  if (method !== "startExec") return "ok";

  if (command === "") return "invalid-request";

  return liveExecs < 8 ? "ok" : "too-many-operations";
}

function codeOf(answer: Answer): string {
  return answer.ok ? "ok" : answer.error.code;
}

function liveTarget() {
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

  const target = new ProjectRpcTarget(
    provider,
    new FakeProjectTransactions(),
    execBackend,
    targetOptions({ endsAtMs: Date.now() + 1_000, activity }),
  );

  return { provider, execBackend, target, touches };
}

function workspaceSnapshot(provider: FakeProjectFilesystemProvider) {
  return [...provider.nodes.keys()].toSorted();
}

async function runTurn(before: readonly Call[], byDeadline: boolean, after: readonly Call[]) {
  const { provider, execBackend, target, touches } = liveTarget();
  let liveExecs = 0;

  for (const [index, next] of before.entries()) {
    const expected = liveAnswer(next, liveExecs);
    expect(codeOf(await perform(target, next, index))).toBe(expected);

    if (next.method === "startExec" && expected === "ok") liveExecs += 1;
  }

  if (byDeadline) await vi.advanceTimersByTimeAsync(1_000);
  const ended = byDeadline ? undefined : await target.endTurn();

  const state = {
    files: workspaceSnapshot(provider),
    execs: execBackend.requests.length,
    touches: touches.count,
  };

  const late = await Promise.all(
    after.map((next, index) => perform(target, next, before.length + index)),
  );

  const cleanup = byDeadline ? await target.endTurn() : ended;

  return { liveExecs, ended: cleanup, state, late, target, provider, execBackend, touches };
}

test("however a turn ends, by endTurn or at its deadline, every later capability call answers turn-ended and changes nothing", async () => {
  await hegel.testAsync(
    async (tc) => {
      const before = tc.draw(gs.arrays(call, { maxSize: 12 }));
      const byDeadline = tc.draw(gs.booleans());
      const after = tc.draw(gs.arrays(call, { minSize: 1, maxSize: 4 }));
      vi.useFakeTimers();

      try {
        const turn = await runTurn(before, byDeadline, after);

        expect(turn.ended).toEqual({
          ok: true,
          value: { killed: byDeadline ? 0 : turn.liveExecs },
        });
        expect(turn.execBackend.handles.map((handle) => handle.killCalls)).toEqual(
          Array.from({ length: turn.liveExecs }, () => 1),
        );
        expect(turn.late).toEqual(after.map(() => ({ ok: false, error: { code: "turn-ended" } })));
        expect(turn.state).toEqual({
          files: workspaceSnapshot(turn.provider),
          execs: turn.execBackend.requests.length,
          touches: turn.touches.count,
        });
        await expect(turn.target.kill("00000000-0000-0000-0000-000000000000:0")).resolves.toEqual({
          ok: true,
          value: null,
        });
        await expect(turn.target.endTurn()).resolves.toEqual(turn.ended);
      } finally {
        vi.useRealTimers();
      }
    },
    { testCases: 150 },
  );
});
