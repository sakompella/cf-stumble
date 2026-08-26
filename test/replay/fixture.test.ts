import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";
import {
  parseReplaySessionJson,
  type ReplayAgentLoop,
  type ReplaySession,
  runReplay,
} from "../../src/replay/index.js";

const fixtureUrl = new URL("../fixtures/sessions/four-primitives.json", import.meta.url);

const fixtureAgent: ReplayAgentLoop = {
  async runTurn(_input, runtime) {
    const response = await runtime.requestModel({ requestId: "executor" });
    const alteredWrite = response.content === "mutated-write";
    if (response.content !== "run-four-primitives" && !alteredWrite) {
      return {
        status: "inconclusive",
        reason: "malformed-response",
        detail: `unknown scripted response ${JSON.stringify(response.content)}`,
      };
    }

    const calls = [
      { kind: "read", path: "README.md" },
      {
        kind: "write",
        path: "notes.txt",
        content: alteredWrite ? "mutated\n" : "created\n",
      },
      { kind: "edit", path: "src/app.ts", oldText: "1", newText: "2" },
      { kind: "bash", command: "printf 'ok\\n'" },
    ] as const;
    for (const call of calls) {
      await runtime.callPrimitive(call);
    }
    return { status: "completed" };
  },
};

async function loadFixture(): Promise<ReplaySession> {
  return parseReplaySessionJson(await readFile(fixtureUrl, "utf8"));
}

test("the fixture exercises every allowed primitive", async () => {
  const fixture = await loadFixture();
  const result = await runReplay(fixture, fixtureAgent);

  expect(fixture.expectedEffects.trace.map((call) => call.kind)).toEqual([
    "read",
    "write",
    "edit",
    "bash",
  ]);
  expect(result.status).toBe("PASS");
});

test("replaying the on-disk fixture twice is deterministic", async () => {
  const fixture = await loadFixture();
  const first = await runReplay(fixture, fixtureAgent);
  const second = await runReplay(fixture, fixtureAgent);

  expect(first).toEqual(second);
});

test("mutating a recorded response is detected as a behavioural FAIL", async () => {
  const fixture = await loadFixture();
  const mutated: ReplaySession = {
    ...fixture,
    turns: fixture.turns.map((turn, index) =>
      index === 0
        ? {
            ...turn,
            modelResponses: turn.modelResponses.map((response) => ({
              ...response,
              content: "mutated-write",
            })),
          }
        : turn,
    ),
  };

  const result = await runReplay(mutated, fixtureAgent);

  expect(result.status).toBe("FAIL");
  if (result.status === "FAIL") {
    expect(result.difference).toMatchObject({ kind: "trace", index: 1 });
  }
});
