import { expect, test } from "vitest";
import { startFacetTurn } from "../../../src/facet/generation-0/facet-turn.js";
import { FakeProjectCapability } from "./fake-project-capability.js";
import {
  calls,
  capabilities,
  encode,
  readFrames,
  routeUnavailable,
  says,
  ScriptedRoute,
  turnStream,
} from "./facet-turn-helpers.js";

/**
 * A turn duplicates the project capability it received, because Workers RPC disposes the received
 * stub the moment the RPC call that carried it returns and the turn outlives that call. The
 * duplicate is then this generation's to release, and there are exactly three ways a turn ends.
 * Each one gets its own test here, because a single test covering all three would pass while two
 * of the paths leaked.
 */

function waitFor(predicate: () => boolean, whatFor: string, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`timed out waiting for ${whatFor}`));
        return;
      }
      setTimeout(poll, 5);
    };
    poll();
  });
}

test("releases the duplicate when the turn completes", async () => {
  const received = FakeProjectCapability.create();
  const route = new ScriptedRoute([
    calls("write", { path: "notes.txt", content: "written by the turn" }),
    says("Wrote it."),
  ]);

  const frames = await readFrames(turnStream(route, received));

  expect(frames.at(-1)).toMatchObject({ kind: "completed" });
  expect(
    received.provider.readFileSync("/project/notes.txt"),
    "the turn must have reached the workspace through the duplicate",
  ).toEqual(encode("written by the turn"));
  expect(received.ledger).toEqual({ dups: 1, disposals: 1, live: 1 });
});

test("releases the duplicate when the turn fails", async () => {
  const received = FakeProjectCapability.create();
  const route = new ScriptedRoute([routeUnavailable]);

  const frames = await readFrames(turnStream(route, received));

  expect(frames.at(-1)).toMatchObject({ kind: "failed", code: "model-error" });
  expect(received.ledger).toEqual({ dups: 1, disposals: 1, live: 1 });
});

test("releases the duplicate when the caller cancels the frame stream", async () => {
  const received = FakeProjectCapability.create();
  const route = new ScriptedRoute([calls("bash", { command: "sleep" }), says("Done.")]);

  const stream = turnStream(route, received);
  const reader = stream.getReader();
  await waitFor(() => received.execBackend.requests.length > 0, "the turn's first command");
  expect(received.ledger.disposals, "the turn is still running").toBe(0);
  expect(route.requests).toHaveLength(1);

  await reader.cancel();

  expect(received.ledger).toEqual({ dups: 1, disposals: 1, live: 1 });
  await new Promise((resolve) => {
    setTimeout(resolve, 50);
  });
  expect(
    route.requests,
    "cancelling aborts the run, so the turn must not go on to its next model call",
  ).toHaveLength(1);
});

test("releases nothing it never duplicated when the request is rejected", async () => {
  const received = FakeProjectCapability.create();
  const route = new ScriptedRoute([]);

  const frames = await readFrames(startFacetTurn(capabilities(route), received, { prompt: 7 }));

  expect(frames).toEqual([{ kind: "rejected", code: "invalid-turn-request" }]);
  expect(received.ledger).toEqual({ dups: 0, disposals: 0, live: 1 });
  expect(route.requests, "no turn ran, so the model was never called").toEqual([]);
});
