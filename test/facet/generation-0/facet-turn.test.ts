import { expect, test } from "vitest";
import { startFacetTurn } from "../../../src/facet/generation-0/facet-turn.js";
import { FakeProjectCapability } from "./fake-project-capability.js";
import { makeFacetExecutionEnv } from "./execution-env-target.js";
import {
  calls,
  capabilities,
  encode,
  readFrames,
  says,
  ScriptedRoute,
  turnStream,
} from "./facet-turn-helpers.js";

test("streams the turn's text, tool results, and terminal state as byte frames", async () => {
  const received = FakeProjectCapability.create();
  received.provider.addFile("/workspace/readme.md", encode("first line"));
  const route = new ScriptedRoute([
    calls("read", { path: "readme.md" }),
    says("The file says: first line"),
  ]);

  const frames = await readFrames(turnStream(route, received));

  expect(frames.map((frame) => frame.kind)).toEqual([
    "tool-start",
    "tool-result",
    "text",
    "completed",
  ]);
  expect(frames[0]).toEqual({
    kind: "tool-start",
    toolCallId: "read-1",
    toolName: "read",
    arguments: { path: "readme.md" },
  });
  expect(frames[1]).toEqual({
    kind: "tool-result",
    toolCallId: "read-1",
    toolName: "read",
    isError: false,
    content: "first line",
    truncated: false,
  });
  expect(frames[2]).toEqual({ kind: "text", text: "The file says: first line" });
});

test("carries the Pi state the next turn continues from in the terminal frame", async () => {
  const received = FakeProjectCapability.create();
  const opening = await readFrames(turnStream(new ScriptedRoute([says("Noted.")]), received));
  const completed = opening.at(-1);
  if (completed?.kind !== "completed") throw new Error("the opening turn must complete");

  const route = new ScriptedRoute([says("Still noted.")]);
  const continued = await readFrames(
    turnStream(route, received, { prompt: "and again", state: completed.state }),
  );

  expect(continued.at(-1)).toMatchObject({ kind: "completed" });
  expect(
    route.requests[0]?.messages.map((message) => message.role),
    "the second turn must resend the first turn's conversation",
  ).toEqual(["system", "user", "assistant", "user"]);
});

test("reports a tool error as a frame rather than ending the turn", async () => {
  const received = FakeProjectCapability.create();
  const route = new ScriptedRoute([calls("read", { path: "missing.txt" }), says("It is missing.")]);

  const frames = await readFrames(turnStream(route, received));

  expect(frames[0]).toMatchObject({ kind: "tool-start", toolName: "read" });
  expect(frames[1]).toMatchObject({ kind: "tool-result", toolName: "read", isError: true });
  expect(frames.at(-1)).toMatchObject({ kind: "completed" });
});

test("rejects a capability whose lifetime this generation cannot own", async () => {
  const { projectTarget } = makeFacetExecutionEnv();
  const route = new ScriptedRoute([says("never reached")]);

  const frames = await readFrames(
    startFacetTurn(capabilities(route), projectTarget, { prompt: "go", state: null }, "/workspace"),
  );

  expect(frames).toEqual([{ kind: "rejected", code: "invalid-project-capability" }]);
  expect(route.requests).toEqual([]);
});
