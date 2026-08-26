import { expect, test } from "vitest";
import {
  REPLAY_SCHEMA_VERSION,
  type ReplayAgentLoop,
  type ReplaySession,
  runReplay,
} from "../../src/replay/runner.js";

const writeCall = { kind: "write", path: "note.txt", content: "new\n" } as const;

const session: ReplaySession = {
  schemaVersion: REPLAY_SCHEMA_VERSION,
  name: "runner-example",
  seed: 11,
  clock: { nowMs: 1_700_000_000_000 },
  initialWorkspace: [{ path: "note.txt", content: "old\n" }],
  turns: [
    {
      input: "update the note",
      modelResponses: [{ requestId: "executor", content: "write" }],
      capturedToolResults: [{ call: writeCall, result: { kind: "write", bytesWritten: 4 } }],
    },
  ],
  expectedEffects: {
    trace: [writeCall],
    finalWorkspace: [{ path: "note.txt", content: "new\n" }],
  },
};

const writingAgent: ReplayAgentLoop = {
  async runTurn(_input, runtime) {
    const response = await runtime.requestModel({ requestId: "executor" });
    if (response.content === "write") {
      await runtime.callPrimitive(writeCall);
    }
    return { status: "completed" };
  },
};

test("replaying a recording twice produces identical results", async () => {
  const first = await runReplay(session, writingAgent);
  const second = await runReplay(session, writingAgent);

  expect(first).toEqual(second);
  expect(first.status).toBe("PASS");
});

test("a changed primitive call produces FAIL", async () => {
  const changedAgent: ReplayAgentLoop = {
    async runTurn(_input, runtime) {
      await runtime.requestModel({ requestId: "executor" });
      await runtime.callPrimitive({ ...writeCall, content: "wrong\n" });
      return { status: "completed" };
    },
  };

  const result = await runReplay(session, changedAgent);

  expect(result.status).toBe("FAIL");
  if (result.status === "FAIL") {
    expect(result.difference.kind).toBe("trace");
  }
});

test("tape exhaustion is INCONCLUSIVE and distinct from FAIL", async () => {
  const overReadingAgent: ReplayAgentLoop = {
    async runTurn(_input, runtime) {
      await runtime.requestModel({ requestId: "executor" });
      await runtime.requestModel({ requestId: "executor" });
      return { status: "completed" };
    },
  };

  const result = await runReplay(session, overReadingAgent);

  expect(result).toMatchObject({ status: "INCONCLUSIVE", reason: "tape-exhausted" });
});

test("an unexpected model request is INCONCLUSIVE", async () => {
  const wrongRequestAgent: ReplayAgentLoop = {
    async runTurn(_input, runtime) {
      await runtime.requestModel({ requestId: "different-request" });
      return { status: "completed" };
    },
  };

  const result = await runReplay(session, wrongRequestAgent);

  expect(result).toMatchObject({
    status: "INCONCLUSIVE",
    reason: "unexpected-model-request",
  });
});

test("a malformed model response is INCONCLUSIVE", async () => {
  const malformedResponseAgent: ReplayAgentLoop = {
    runTurn(_input, _runtime) {
      return Promise.resolve({
        status: "inconclusive",
        reason: "malformed-response",
        detail: "response did not contain an action",
      });
    },
  };

  const result = await runReplay(session, malformedResponseAgent);

  expect(result).toMatchObject({
    status: "INCONCLUSIVE",
    reason: "malformed-response",
  });
});

test("a timed-out turn is INCONCLUSIVE", async () => {
  const hangingAgent: ReplayAgentLoop = {
    async runTurn() {
      await new Promise<void>(() => {});
      return { status: "completed" };
    },
  };

  const result = await runReplay(session, hangingAgent, { timeoutMs: 5 });

  expect(result).toMatchObject({ status: "INCONCLUSIVE", reason: "timeout" });
});
