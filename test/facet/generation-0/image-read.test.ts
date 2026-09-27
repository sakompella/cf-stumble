import { expect, test } from "vitest";
import {
  parseThreadMessages,
  serializeThreadMessages,
} from "../../../src/supervisor/threads/index.js";
import { FakeProjectCapability } from "./fake-project-capability.js";
import {
  calls,
  readFrames,
  routeUnavailable,
  says,
  ScriptedRoute,
  turnStream,
} from "./facet-turn-helpers.js";
import type { AgentMessage } from "@cf-stumble/pi";
import type { FacetTurnFrame } from "../../../src/facet/generation-0/index.js";

const PIXEL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

/** A complete 1x1 PNG, so the read tool's own signature check classifies it as an image. */
const PIXEL_PNG = Uint8Array.from(
  atob(PIXEL_PNG_BASE64),
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

/**
 * The thread an earlier build of this generation saved: the stock read tool put the PNG in the
 * tool result, and the route then failed the turn. Nothing rewrites saved threads, so the route
 * itself must still take a follow-up on one.
 */
function threadSavedWithImage(messages: readonly AgentMessage[]): readonly AgentMessage[] {
  return messages.map((message) =>
    message.role === "toolResult"
      ? {
          ...message,
          content: [
            { type: "text", text: "Read image file [image/png]" },
            { type: "image", data: PIXEL_PNG_BASE64, mimeType: "image/png" },
          ],
        }
      : message,
  );
}

test("a thread saved holding an image result takes a text follow-up that names the omission", async () => {
  const received = FakeProjectCapability.create();
  received.provider.addFile("/workspace/pixel.png", PIXEL_PNG);

  const opening = await readFrames(
    turnStream(
      new ScriptedRoute([calls("read", { path: "pixel.png" }), routeUnavailable]),
      received,
    ),
  );

  const saved = saveAndReload(threadSavedWithImage(terminalMessages(opening)));
  expect(JSON.stringify(saved)).toContain('"type":"image"');

  const followUp = new ScriptedRoute([says("I cannot see images here.")]);

  const frames = await readFrames(
    turnStream(followUp, received, { prompt: "What did the picture show?", messages: saved }),
  );

  expect(frames.at(-1)).toMatchObject({ kind: "completed" });
  expect(followUp.requests).toHaveLength(1);

  const toolMessage = followUp.requests[0]?.messages.find((message) => message.role === "tool");
  expect(toolMessage?.content).toContain("Read image file [image/png]");
  expect(toolMessage?.content).toContain("Image omitted");
});
