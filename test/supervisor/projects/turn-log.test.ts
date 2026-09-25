/// <reference types="@cloudflare/vitest-plugin/types" />

import { reset } from "cloudflare:test";
import { afterEach, expect, test, vi } from "vitest";
import { activateFixtureGeneration, connectedSupervisor as supervisor } from "../helpers.js";
import { THREAD_MESSAGE_SAMPLES } from "../threads/message-samples.js";
import { runScriptedTurn } from "./turn-run-helpers.js";
import { facetRunning, projectWorkspaces, turnFor } from "./project-turn-helpers.js";
import { says } from "../../facet/generation-0/facet-turn-helpers.js";
import { sampleProjectOne } from "../../project-fixtures.js";
import { capturedEvents, named } from "../../log-capture.js";

/**
 * A turn that goes wrong in production has to be diagnosable from Workers Logs alone. Each test
 * runs one turn against a real thread store and reads back the structured events it wrote: when
 * it was admitted, how its start went, and how it settled, with frame counts rather than frames.
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

test("a saved turn logs its admission, start, first frame, and settlement with frame counts", async () => {
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
  const [admitted] = named(logged, "turn.admitted");
  expect(admitted).toMatchObject({ level: "info", projectId: "sample-project-one" });
  expect(String(admitted?.lease), "only a suffix of the lease id is logged").toHaveLength(8);
  expect(named(logged, "turn.started")).toEqual([
    expect.objectContaining({ outcome: "started", lease: admitted?.lease }),
  ]);
  expect(named(logged, "turn.first-frame")).toHaveLength(1);
  expect(named(logged, "turn.settled")).toEqual([
    expect.objectContaining({
      level: "info",
      lease: admitted?.lease,
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
  const logged = events();
  expect(named(logged, "turn.started")).toEqual([
    expect.objectContaining({ level: "warn", outcome: "workspace-unavailable" }),
  ]);
  expect(named(logged, "turn.lease-abandoned")).toEqual([
    expect.objectContaining({ why: "workspace-unavailable" }),
  ]);
  expect(named(logged, "turn.refused")).toEqual([
    expect.objectContaining({ code: "workspace-unavailable" }),
  ]);
});

test("a start that throws logs the abandoned lease before the error leaves", async () => {
  const events = capturedEvents();
  const control = await supervisor("turn-log-start-threw");
  await activateFixtureGeneration(control);

  await expect(runScriptedTurn(control, { throwStart: true })).rejects.toThrow("start failed");

  const logged = events();
  expect(named(logged, "turn.started")).toEqual([
    expect.objectContaining({ level: "error", outcome: "threw" }),
  ]);
  expect(named(logged, "turn.lease-abandoned")).toEqual([
    expect.objectContaining({ why: "start-threw" }),
  ]);
});

test("a turn refused before admission logs its code and takes no lease", async () => {
  const events = capturedEvents();
  const control = await supervisor("turn-log-invalid-prompt");
  await activateFixtureGeneration(control);

  await runScriptedTurn(control, { prompt: "   " });

  const logged = events();
  expect(named(logged, "turn.refused")).toEqual([
    expect.objectContaining({ code: "invalid-prompt" }),
  ]);
  expect(named(logged, "turn.admitted")).toEqual([]);
});

test("a real Supervisor logs its mount and provisioning steps with durations", async () => {
  const events = capturedEvents();
  const control = await supervisor("turn-log-supervisor-steps");
  await activateFixtureGeneration(control);

  // workerd has no container, so the repository provision cannot reach a workspace here.
  expect(await control.runProjectTurn("sample-project-one", "do the work")).toEqual({
    ok: false,
    problem: { code: "workspace-unavailable" },
  });

  const logged = events();
  const [admitted] = named(logged, "turn.admitted");
  expect(admitted?.generation, "the turn was admitted against the fixture generation").toBeTypeOf(
    "number",
  );
  expect(named(logged, "turn.mounted")).toEqual([
    expect.objectContaining({
      outcome: "mounted",
      lease: admitted?.lease,
      generation: admitted?.generation,
    }),
  ]);
  const [provisioned] = named(logged, "turn.provisioned");
  expect(provisioned).toMatchObject({
    level: "warn",
    target: "repository",
    outcome: "provisioning-failed",
    lease: admitted?.lease,
  });
  expect(provisioned?.durationMs).toBeGreaterThanOrEqual(0);
});

test("obtaining the workspace capability is logged as a Workspace Host RPC", async () => {
  const events = capturedEvents();
  const workspaces = await projectWorkspaces();
  const facet = await facetRunning([says("Nothing to do.")]);

  const start = await turnFor(workspaces, facet, sampleProjectOne.id);

  expect(start.ok).toBe(true);
  expect(named(events(), "workspace.rpc")).toEqual([
    expect.objectContaining({ level: "info", method: "project", outcome: "ok" }),
  ]);
});
