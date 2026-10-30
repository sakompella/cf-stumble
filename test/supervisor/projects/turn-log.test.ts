/// <reference types="@cloudflare/vitest-plugin/types" />

import { reset } from "cloudflare:test";
import { afterEach, expect, test, vi } from "vitest";
import { activateFixtureGeneration, connectedSupervisor as supervisor } from "../helpers.js";
import { THREAD_MESSAGE_SAMPLES } from "../threads/message-samples.js";
import { runScriptedTurn } from "./turn-run-helpers.js";
import { capturedEvents, named } from "../../log-capture.js";

/**
 * A turn that goes wrong in production has to be diagnosable from Workers Logs alone. Each test
 * runs one turn against a real thread store and reads back the structured events it wrote: how it
 * settled, with frame counts rather than frames, or why its lease was given back.
 * No event may carry the prompt, a frame's text, or the whole lease id.
 */

const conversation = [THREAD_MESSAGE_SAMPLES.user, THREAD_MESSAGE_SAMPLES.assistant];

const completed = { kind: "completed", state: { messages: conversation } };

const PROMPT = "please refactor the secret sauce";

const toolStart = { kind: "tool-start", toolCallId: "call-1", toolName: "bash", arguments: {} };

const toolResult = {
  kind: "tool-result",
  toolCallId: "call-1",
  toolName: "bash",
  isError: false,
  content: "private tool output",
  truncated: false,
};

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

test("a saved turn logs its settlement with frame counts", async () => {
  const events = capturedEvents();
  const control = await supervisor("turn-log-saved");
  await activateFixtureGeneration(control);

  const observed = await runScriptedTurn(control, {
    prompt: PROMPT,
    frames: [
      { kind: "text", text: "thinking" },
      toolStart,
      toolResult,
      { kind: "text", text: "done" },
      completed,
    ],
  });

  expect(observed.frames.at(-1)).toMatchObject({ kind: "saved" });
  const logged = events();
  const [settled] = named(logged, "turn.settled");
  expect(String(settled?.lease), "only a suffix of the lease id is logged").toHaveLength(8);
  expect(named(logged, "turn.settled")).toEqual([
    expect.objectContaining({
      level: "info",
      projectId: "sample-project-one",
      ending: "saved",
      frames: 4,
      textFrames: 2,
      toolStartFrames: 1,
      toolResultFrames: 1,
      revision: 1,
      messageCount: conversation.length,
    }),
  ]);
  const written = JSON.stringify(logged);
  expect(written, "the prompt is the owner's text").not.toContain("secret sauce");
  expect(written, "frame content is the workspace's text").not.toContain("private tool output");
});

test("a stream that breaks the protocol settles at error level with its code", async () => {
  const events = capturedEvents();
  const control = await supervisor("turn-log-invalid");
  await activateFixtureGeneration(control);

  await runScriptedTurn(control, { lines: ["{not json"] });

  expect(named(events(), "turn.settled")).toEqual([
    expect.objectContaining({ level: "error", ending: "stream-invalid", code: "malformed-frame" }),
  ]);
});

test("a start the generation refuses logs why the lease was abandoned", async () => {
  const events = capturedEvents();
  const control = await supervisor("turn-log-refused-start");
  await activateFixtureGeneration(control);

  const observed = await runScriptedTurn(control, {
    refuseStart: { ok: false, reason: "workspace-unavailable" },
  });

  expect(observed.refused).toBe("workspace-unavailable");
  expect(named(events(), "turn.lease-abandoned")).toEqual([
    expect.objectContaining({ why: "workspace-unavailable" }),
  ]);
});

test("a start that throws logs the abandoned lease before the error leaves", async () => {
  const events = capturedEvents();
  const control = await supervisor("turn-log-start-threw");
  await activateFixtureGeneration(control);

  await expect(runScriptedTurn(control, { throwStart: true })).rejects.toThrow("start failed");

  expect(named(events(), "turn.lease-abandoned")).toEqual([
    expect.objectContaining({ why: "start-threw" }),
  ]);
});
