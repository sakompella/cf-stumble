import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import * as Schema from "effect/Schema";
import { expect, test, vi } from "vitest";
import { startExecOperation } from "../../../src/workspace/project/exec-operation.js";
import { deferredExec } from "./deferred-exec.js";
import { FakeExecBackend } from "./fakes.js";

const ACTIONS = [
  "resolve",
  "reject",
  "kill",
  "cancel",
  "exit",
  "eof",
  "readFail",
  "advance",
] as const;

type Action = (typeof ACTIONS)[number];

type Step = readonly [Action, number];

type Outcome = "exited" | "failed" | "killed" | "timed-out" | "cancelled";

interface Expected {
  readonly outcome: Outcome | undefined;
  readonly kills: number;
}

const BACKEND_ENDINGS = { exit: "exited", eof: "failed", readFail: "failed" } as const;

function expectedSettlement(steps: readonly Step[], timeoutMs: number): Expected {
  let elapsed = 0;
  let arrival: "pending" | "arrived" | "rejected" = "pending";
  let backendEnding: Outcome | undefined;
  let outcome: Outcome | undefined;

  const settleWith = (next: Outcome): void => {
    if (outcome !== undefined) return;
    outcome = next;
  };

  const settleOnBackendEnding = (): void => {
    if (arrival === "arrived" && backendEnding !== undefined && outcome === undefined) {
      settleWith(backendEnding);
    }
  };

  for (const [action, ms] of [...steps, ["resolve", 0] as const]) {
    if (action === "resolve" && arrival === "pending") {
      arrival = "arrived";
      settleOnBackendEnding();
    } else if (action === "reject" && arrival === "pending") {
      arrival = "rejected";
      settleWith("failed");
    } else if (action === "kill") {
      settleWith("killed");
    } else if (action === "cancel") {
      settleWith("cancelled");
    } else if (action === "advance") {
      elapsed += ms;

      if (elapsed >= timeoutMs) settleWith("timed-out");
    } else if (action === "exit" || action === "eof" || action === "readFail") {
      backendEnding ??= BACKEND_ENDINGS[action];
      settleOnBackendEnding();
    }
  }

  const killsTheHandle = outcome !== undefined && outcome !== "exited" && arrival !== "rejected";

  return { outcome, kills: killsTheHandle ? 1 : 0 };
}

const KILL_BEHAVIORS = {
  ok: () => Promise.resolve(),
  reject: () => Promise.reject(new Error("kill failed")),
  hang: () => new Promise<void>(() => {}),
};

async function runSteps(
  steps: readonly Step[],
  timeoutMs: number,
  killBehavior: keyof typeof KILL_BEHAVIORS,
) {
  const backend = new FakeExecBackend();
  const deferred = deferredExec();
  backend.deferNextExec(deferred);
  deferred.handle.killBehavior = KILL_BEHAVIORS[killBehavior];
  let settledCount = 0;

  const operation = startExecOperation(
    backend,
    { command: "x", cwd: "/workspace", timeoutMs },
    () => {
      settledCount += 1;
    },
  );

  const reader = operation.events.getReader();
  const frames: Uint8Array[] = [];
  const stream = { closed: false };

  void (async () => {
    for (let next = await reader.read(); !next.done; next = await reader.read()) {
      frames.push(next.value);
    }

    stream.closed = true;
  })();

  const perform = async (action: Action, ms: number): Promise<void> => {
    if (action === "resolve") deferred.resolve();
    else if (action === "reject") deferred.reject(new Error("spawn failed"));
    else if (action === "kill") operation.requestKill();
    else if (action === "cancel") await reader.cancel();
    else if (action === "exit") deferred.handle.push({ name: "exit", exitCode: 7 });
    else if (action === "eof") deferred.handle.end();
    else if (action === "readFail") deferred.handle.fail(new Error("stream broke"));
    else await vi.advanceTimersByTimeAsync(ms);

    await vi.advanceTimersByTimeAsync(0);
  };

  for (const [action, ms] of steps) await perform(action, ms);

  deferred.resolve();
  await vi.advanceTimersByTimeAsync(0);

  return { frames, settledCount, closed: stream.closed, kills: deferred.handle.killCalls };
}

const decodeFrame = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      kind: Schema.String,
      seq: Schema.Number,
      outcome: Schema.optionalKey(Schema.String),
    }),
  ),
);

function terminalsOf(frames: readonly Uint8Array[]) {
  return frames.flatMap((frame) => {
    const event = decodeFrame(new TextDecoder().decode(frame));

    return event.kind === "terminal" ? [event] : [];
  });
}

test("however a timeout, a kill, a cancel, a late handle and backend endings interleave, the operation settles once with the first cause, whether the backend kill succeeds, fails or hangs", async () => {
  await hegel.testAsync(
    async (tc) => {
      const timeoutMs = tc.draw(gs.integers({ minValue: 1, maxValue: 200 }));

      const steps = tc.draw(
        gs.arrays(gs.tuples(gs.sampledFrom(ACTIONS), gs.integers({ minValue: 0, maxValue: 250 })), {
          maxSize: 8,
        }),
      );

      const killBehavior = tc.draw(gs.sampledFrom(["ok", "reject", "hang"] as const));

      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

      try {
        const expected = expectedSettlement(steps, timeoutMs);
        const seen = await runSteps(steps, timeoutMs, killBehavior);
        const terminals = terminalsOf(seen.frames);

        expect(seen.settledCount).toBe(expected.outcome === undefined ? 0 : 1);
        expect(seen.kills).toBe(expected.kills);
        expect(seen.closed).toBe(expected.outcome !== undefined);

        if (expected.outcome === undefined || expected.outcome === "cancelled") {
          expect(terminals).toEqual([]);
        } else {
          expect(terminals).toHaveLength(1);
          expect(terminals[0]).toMatchObject({ seq: 0, outcome: expected.outcome });
        }
      } finally {
        vi.useRealTimers();
      }
    },
    { testCases: 300 },
  );
});
