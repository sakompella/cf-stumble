import { expect, test } from "vitest";
import {
  parseThreadMessages,
  serializeThreadMessages,
} from "../../../src/supervisor/threads/index.js";
import { FakeProjectCapability } from "./fake-project-capability.js";
import { calls, readFrames, says, ScriptedRoute, turnStream } from "./facet-turn-helpers.js";
import type { AgentMessage } from "@cf-stumble/pi";
import type { FacetTurnFrame } from "../../../src/facet/generation-0/index.js";

/** A complete 1x1 PNG, so the read tool's own signature check classifies it as an image. */
const PIXEL_PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  ),
  (character) => character.codePointAt(0) ?? 0,
);

function terminalMessages(frames: readonly FacetTurnFrame[]): readonly AgentMessage[] {
  const terminal = frames.at(-1);

  if (terminal?.kind !== "completed" && terminal?.kind !== "failed") {
    throw new Error("the turn must end with a conversation to save");
  }

  return terminal.state.messages;
}

/** The Supervisor's own write and read of a thread column, as a saved-and-reloaded thread. */
function saveAndReload(messages: readonly AgentMessage[]): readonly AgentMessage[] {
  const reloaded = parseThreadMessages(serializeThreadMessages(messages));

  if (reloaded.isErr()) throw new Error(`the saved thread must parse: ${reloaded.error.reason}`);

  return reloaded.value;
}

test("reading a PNG answers in text the route carries, and the reloaded thread keeps working", async () => {
  const received = FakeProjectCapability.create();
  received.provider.addFile("/workspace/pixel.png", PIXEL_PNG);

  const opening = new ScriptedRoute([calls("read", { path: "pixel.png" }), says("It is a PNG.")]);
  const openingFrames = await readFrames(turnStream(opening, received));

  expect(openingFrames.at(-1)).toMatchObject({ kind: "completed" });
  expect(
    opening.requests,
    "the model sees the tool result instead of the turn failing",
  ).toHaveLength(2);

  const toolResult = terminalMessages(openingFrames).find(
    (message) => message.role === "toolResult",
  );

  expect(toolResult).toMatchObject({ role: "toolResult", toolName: "read", isError: false });
  expect(JSON.stringify(toolResult?.content)).toContain("image/png");
  expect(JSON.stringify(toolResult?.content)).toContain("text only");
  expect(
    toolResult?.role === "toolResult" && toolResult.content.every((block) => block.type === "text"),
    "the saved thread holds no image block for a later turn to meet",
  ).toBe(true);

  const followUp = new ScriptedRoute([says("Still here.")]);

  const followUpFrames = await readFrames(
    turnStream(followUp, received, {
      prompt: "What else is in the repository?",
      messages: saveAndReload(terminalMessages(openingFrames)),
    }),
  );

  expect(followUpFrames.at(-1)).toMatchObject({ kind: "completed" });
  expect(followUp.requests).toHaveLength(1);
});

test("the read tool does not promise the model image attachments the route cannot carry", async () => {
  const route = new ScriptedRoute([says("Ready.")]);
  await readFrames(turnStream(route, FakeProjectCapability.create()));

  const read = route.requests[0]?.tools?.find((tool) => tool.function.name === "read");
  expect(read?.function.description).toContain("text only");
  expect(read?.function.description).not.toContain("attachments");
});
