/// <reference types="@cloudflare/vitest-plugin/types" />

import { reset } from "cloudflare:test";
import { afterEach, expect, expectTypeOf, test } from "vitest";
import { activateFixtureGeneration, connectedSupervisor as supervisor } from "../helpers.js";
import { THREAD_MESSAGE_SAMPLES } from "../threads/message-samples.js";
import { NOW, runScriptedTurn } from "./turn-run-helpers.js";
import { admitProjectTurn } from "../threads/turn-slot.js";
import { PROJECT_TURN_LEASE_MS } from "../../../src/supervisor/supervisor.js";
import type { ProjectTurnRun } from "../../../src/supervisor/projects/index.js";

/**
 * What one turn earns, and what it does not.
 *
 * Goal criterion 6: success requires Pi terminal success and a committed thread save, and a
 * rejected, failed, truncated, cancelled, or unsaved turn earns no completed-real-turn credit.
 * Every test here reads the credit ledger after the turn has settled, because the credit is the
 * durable record and not the frame the browser happened to receive.
 */

const conversation = [THREAD_MESSAGE_SAMPLES.user, THREAD_MESSAGE_SAMPLES.assistant];

const completedTurn = [
  { kind: "text", text: "reading the file" },
  {
    kind: "tool-start",
    toolCallId: "call-1",
    toolName: "bash",
    arguments: { command: "git diff" },
  },
  {
    kind: "tool-result",
    toolCallId: "call-1",
    toolName: "bash",
    isError: false,
    content: "diff --git a/notes.md b/notes.md",
    truncated: false,
  },
  { kind: "completed", state: { messages: conversation } },
];

afterEach(async () => {
  await reset();
});

test("a turn hands the browser no lease and the generation no model or tenant", async () => {
  expectTypeOf<Extract<ProjectTurnRun, { ok: true }>>().toEqualTypeOf<
    Readonly<{ ok: true; frames: ReadableStream<Uint8Array> }>
  >();

  const control = await supervisor("turn-handoff");
  await activateFixtureGeneration(control);
  const handed: unknown[] = [];
  await runScriptedTurn(control, {
    frames: completedTurn,
    handoff: (request) => {
      handed.push(request);
    },
  });

  // The prompt this request carried and the conversation the Supervisor saved. No model, no
  // system prompt, no lease, no tenant, and no capability: those are not the client's to send and
  // not this side's to invent.
  expect(handed).toEqual([{ prompt: "do the work", messages: [] }]);
});

test("a completed turn is saved first, then reported, and earns exactly one credit", async () => {
  const control = await supervisor("turn-completed");
  await activateFixtureGeneration(control);

  const observed = await runScriptedTurn(control, { frames: completedTurn });

  // The generation's own frames reach the browser unchanged in meaning, and the turn's ending is
  // the Supervisor's own frame: `saved` exists only because the commit returned.
  expect(observed.frames.slice(0, 3)).toEqual(completedTurn.slice(0, 3));
  expect(observed.frames.at(-1)).toEqual({
    kind: "saved",
    revision: 1,
    messageCount: conversation.length,
    credited: true,
  });
  expect(observed.thread).toMatchObject({
    conversation: JSON.stringify(conversation),
    revision: 1,
    turnActive: false,
  });
  expect(observed.credits).toMatchObject([
    { attemptId: 1, projectId: "sample-project-one", threadRevision: 1, generationLabel: 0 },
  ]);
  expect(observed.attempts).toMatchObject([
    { id: 1, outcome: "body-completed", responseStatus: 200, generationLabel: 0 },
  ]);
});

test("a turn whose save fails reports no success and earns no credit", async () => {
  const control = await supervisor("turn-save-fails");
  await activateFixtureGeneration(control);

  // Terminal success carrying something that is not a Pi conversation. The thread refuses it, so
  // there is no committed save, and a `body-completed` attempt with status 200 earns nothing.
  const observed = await runScriptedTurn(control, {
    frames: [{ kind: "completed", state: { messages: [{ role: "telepathy", timestamp: 1 }] } }],
  });

  expect(observed.frames).toEqual([{ kind: "save-failed", code: "invalid-messages" }]);
  expect(observed.credits).toEqual([]);
  expect(observed.thread).toMatchObject({ conversation: "[]", revision: 0, turnActive: false });
  // The generation still served a clean stream, so its own record says so (ADR-0031). The two
  // facts are separate on purpose: a storage failure here is not evidence about the harness.
  expect(observed.attempts).toMatchObject([{ outcome: "body-completed", responseStatus: 200 }]);
});

test("a failed turn keeps its conversation under the documented policy and earns no credit", async () => {
  const control = await supervisor("turn-failed");
  await activateFixtureGeneration(control);

  const observed = await runScriptedTurn(control, {
    frames: [
      { kind: "text", text: "trying" },
      { kind: "failed", code: "model-call-limit", state: { messages: conversation } },
    ],
  });

  expect(observed.frames.at(-1)).toEqual({
    kind: "turn-failed",
    code: "model-call-limit",
    saved: true,
    revision: 1,
  });
  expect(observed.thread).toMatchObject({ revision: 1, turnActive: false });
  expect(observed.credits).toEqual([]);
});

test("a rejected turn saves nothing, keeps the thread, and frees the slot", async () => {
  const control = await supervisor("turn-rejected");
  await activateFixtureGeneration(control);

  const observed = await runScriptedTurn(control, {
    frames: [{ kind: "rejected", code: "invalid-turn-request" }],
  });

  expect(observed.frames).toEqual([{ kind: "turn-rejected", code: "invalid-turn-request" }]);
  expect(observed.thread).toMatchObject({ revision: 0, turnActive: false, messageCount: 0 });
  expect(observed.credits).toEqual([]);
});

test("a project already running a turn refuses the second one without touching the first", async () => {
  const control = await supervisor("turn-conflict");
  await activateFixtureGeneration(control);
  // A turn already holds the project's lease. The second turn's generation is never reached,
  // because admission refuses before anything is started.
  await admitProjectTurn(control, "sample-project-one", 0, NOW, PROJECT_TURN_LEASE_MS);

  const refused = await runScriptedTurn(control, { frames: completedTurn });

  expect(refused.refused).toBe("turn-conflict");
  expect(refused.credits).toEqual([]);
  expect(refused.thread).toMatchObject({ turnActive: true, revision: 0, messageCount: 0 });
});

test("an unsaved relayed request earns no real-turn credit however good its status", async () => {
  const control = await supervisor("turn-credit-not-http");
  await activateFixtureGeneration(control);

  // A successful `GET /` through the relay: a completed body under 400, which is exactly what
  // generation eligibility credits. It saved no thread, so it is not a completed real turn.
  const startupCheck = await control.fetch(new Request("https://cf-stumble.test/"));

  expect(startupCheck.status).toBe(200);
  expect(await control.getCompletedRealTurns()).toEqual([]);
});
