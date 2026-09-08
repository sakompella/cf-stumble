/// <reference types="@cloudflare/vitest-plugin/types" />

import { reset } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import { GenerationControl } from "../../../src/supervisor/control/index.js";
import { Generations } from "../../../src/supervisor/generations/index.js";
import {
  activateFixtureGeneration,
  commits,
  connectedSupervisor as supervisor,
  prepareGeneration,
  submitCandidate,
} from "../helpers.js";
import { THREAD_MESSAGE_SAMPLES } from "../threads/message-samples.js";
import { runScriptedTurn } from "./turn-run-helpers.js";
import { PROJECT_TURN_FRAME_MAX_BYTES } from "../../../src/supervisor/projects/index.js";

/**
 * What a turn does when the stream it is reading is not a turn.
 *
 * A generation is mutable harness code, so its stream is input: it can be malformed, oversized,
 * truncated, or say that the turn ended twice. None of those may save arbitrary state or count as
 * success (goal criterion 6).
 */

const conversation = [THREAD_MESSAGE_SAMPLES.user, THREAD_MESSAGE_SAMPLES.assistant];
const completed = { kind: "completed", state: { messages: conversation } };

afterEach(async () => {
  await reset();
});

test("a stream that ends without saying how the turn ended saves nothing", async () => {
  const control = await supervisor("turn-truncated");
  await activateFixtureGeneration(control);

  const observed = await runScriptedTurn(control, { frames: [{ kind: "text", text: "half a t" }] });

  expect(observed.frames.at(-1)).toEqual({
    kind: "stream-invalid",
    code: "missing-terminal-frame",
  });
  expect(observed.thread).toMatchObject({ conversation: "[]", revision: 0, turnActive: false });
});

test("an empty stream saves nothing and frees the project", async () => {
  const control = await supervisor("turn-empty-eof");
  await activateFixtureGeneration(control);

  const observed = await runScriptedTurn(control, { frames: [] });

  expect(observed.frames).toEqual([{ kind: "stream-invalid", code: "missing-terminal-frame" }]);
  expect(observed.thread).toMatchObject({ revision: 0, turnActive: false });
});

test("a second terminal frame cannot save a second conversation on one lease", async () => {
  const control = await supervisor("turn-duplicate-terminal");
  await activateFixtureGeneration(control);

  // Two terminal frames in one write, so the second is already there when the first ends the
  // turn. The read stops at the first one and the lease it saved under is spent, so the second
  // conversation reaches neither the thread nor the browser.
  const observed = await runScriptedTurn(control, {
    lines: [
      `${JSON.stringify(completed)}\n${JSON.stringify({ kind: "completed", state: { messages: [] } })}`,
    ],
  });

  expect(observed.frames).toEqual([
    { kind: "saved", revision: 1, messageCount: conversation.length },
  ]);
  expect(observed.thread).toMatchObject({
    conversation: JSON.stringify(conversation),
    revision: 1,
    turnActive: false,
  });
});

test("a malformed line ends the turn instead of being passed on", async () => {
  const control = await supervisor("turn-malformed");
  await activateFixtureGeneration(control);

  const observed = await runScriptedTurn(control, {
    lines: ["{not json", JSON.stringify(completed)],
  });

  expect(observed.frames).toEqual([{ kind: "stream-invalid", code: "malformed-frame" }]);
});

test("a frame of a kind this Supervisor does not know is malformed, not forwarded", async () => {
  const control = await supervisor("turn-unknown-kind");
  await activateFixtureGeneration(control);

  const observed = await runScriptedTurn(control, {
    lines: [JSON.stringify({ kind: "invented", detail: "not a frame" })],
  });

  expect(observed.frames).toEqual([{ kind: "stream-invalid", code: "malformed-frame" }]);
});

test("a frame missing a field its kind declares reaches no browser", async () => {
  const control = await supervisor("turn-incomplete-frame");
  await activateFixtureGeneration(control);

  const observed = await runScriptedTurn(control, {
    lines: [JSON.stringify({ kind: "tool-result", toolCallId: "call-1", toolName: "bash" })],
  });

  expect(observed.frames).toEqual([{ kind: "stream-invalid", code: "malformed-frame" }]);
});

test("a diff frame that does not say whether it was cut reaches no browser", async () => {
  const control = await supervisor("turn-incomplete-diff");
  await activateFixtureGeneration(control);

  const observed = await runScriptedTurn(control, {
    lines: [JSON.stringify({ kind: "diff", content: "diff --git a/a b/a" })],
  });

  expect(observed.frames).toEqual([{ kind: "stream-invalid", code: "malformed-frame" }]);
});

test("an oversized frame ends the turn rather than being buffered", async () => {
  const control = await supervisor("turn-oversized");
  await activateFixtureGeneration(control);

  const observed = await runScriptedTurn(control, {
    lines: [
      JSON.stringify({ kind: "text", text: "x".repeat(PROJECT_TURN_FRAME_MAX_BYTES + 1) }),
      JSON.stringify(completed),
    ],
  });

  expect(observed.frames).toEqual([{ kind: "stream-invalid", code: "oversized-frame" }]);
  expect(observed.thread).toMatchObject({ conversation: "[]", turnActive: false });
});

test("a browser that goes away mid-turn cancels the work and saves nothing", async () => {
  const control = await supervisor("turn-cancelled");
  await activateFixtureGeneration(control);

  const observed = await runScriptedTurn(control, {
    frames: [{ kind: "text", text: "working" }],
    keepOpen: true,
    cancelAfter: 1,
  });

  // Nothing was fabricated for the turn nobody was left to receive: the conversation is what it
  // was, and the project is free for the next turn.
  expect(observed.thread).toMatchObject({ conversation: "[]", revision: 0, turnActive: false });
});

test("a save that committed before the disconnect stands", async () => {
  const control = await supervisor("turn-cancel-after-save");
  await activateFixtureGeneration(control);

  // The browser reads the text and the `saved` frame, then goes away. `saved` exists only after
  // the commit returned, so this is the disconnect that arrives once the turn is already durable.
  const observed = await runScriptedTurn(control, {
    frames: [{ kind: "text", text: "done" }, completed],
    keepOpen: true,
    cancelAfter: 2,
  });

  expect(observed.frames.at(-1)).toMatchObject({ kind: "saved", revision: 1 });
  expect(observed.thread).toMatchObject({ revision: 1, turnActive: false });
});

test("a turn that never ends is bounded, and gives the project back", async () => {
  const control = await supervisor("turn-deadline");
  await activateFixtureGeneration(control);

  // A lost facet or an interrupted host leaves a stream that never closes and never sends a
  // terminal frame. No alarm and no sweeper is involved: the turn bounds itself.
  const observed = await runScriptedTurn(control, {
    frames: [{ kind: "text", text: "thinking" }],
    keepOpen: true,
    deadlineMs: 25,
  });

  expect(observed.frames.at(-1)).toEqual({ kind: "timed-out" });
  expect(observed.thread).toMatchObject({ revision: 0, turnActive: false });
});

test("activating a generation mid-turn does not disturb the running turn", async () => {
  const control = await supervisor("turn-activation-mid-flight");
  await activateFixtureGeneration(control);
  const second = await submitCandidate(control, commits.ordinary);
  await prepareGeneration(control, second, commits.ordinary);

  const observed = await runScriptedTurn(control, {
    frames: [{ kind: "text", text: "working" }],
    keepOpen: true,
    whileRunning: (state, generation) => {
      const generations = new Generations(state.storage);
      new GenerationControl(generations).execute({
        principal: { kind: "user" },
        command: { kind: "activate", label: second, observedEpoch: generations.active().epoch },
      });
      generation.frame(completed);
      generation.close();
    },
  });

  // The activation decides what the next turn runs on. This one was admitted on generation 0 and
  // drains there, so it still saves the conversation it produced.
  expect(observed.activeLabel).toBe(second);
  expect(observed.frames.at(-1)).toMatchObject({ kind: "saved", revision: 1 });
  expect(observed.thread).toMatchObject({ revision: 1, turnActive: false });
});

test("a start that never answers is bounded, and the project does not stay held", async () => {
  const control = await supervisor("turn-start-stalls");
  await activateFixtureGeneration(control);

  // A lost facet or an interrupted host answers neither yes nor no. Without a bound on the start
  // itself, the browser would wait on a stream nobody will write and the lease would be held
  // until it expired.
  const observed = await runScriptedTurn(control, { stallStart: true, deadlineMs: 25 });

  expect(observed.refused).toBe("turn-not-started");
  expect(observed.thread).toMatchObject({ revision: 0, turnActive: false });
});
