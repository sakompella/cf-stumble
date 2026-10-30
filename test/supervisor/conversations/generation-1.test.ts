/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, test, vi } from "vitest";
import { sampleProjectOne } from "../../project-fixtures.js";
import {
  calls,
  held,
  lines,
  ProjectWorkspace,
  says,
  scriptModel,
  servingGeneration1,
  submitted,
  untilAnswered,
} from "./generation-1-session.js";

/**
 * Generation 1 as built, served by the Supervisor through its RPC surface, with the real model
 * route and a real project capability. Only OpenAI and Computer are fakes.
 */

const project = sampleProjectOne.id;

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

test("a run cut off by a Supervisor reset resumes from the Supervisor's alarm and is answered", async () => {
  const interrupted = held();
  const model = scriptModel(interrupted.respond, says("resumed answer"));
  const lost = await servingGeneration1("generation-1-resume", new ProjectWorkspace());

  await submitted(lost, project, "hello", "r1");
  await vi.waitUntil(() => model.inputs.length === 1);

  await expect(
    runInDurableObject(lost, (_instance, state) => {
      state.abort("the platform reset the Supervisor");
    }),
  ).rejects.toThrow();
  interrupted.release(says("an answer nobody reads"));

  // A stub to an aborted object stays broken; the next one reaches a new instance.
  const control = env.SUPERVISOR.getByName("generation-1-resume");

  expect(await runDurableObjectAlarm(control)).toBe(true);
  await vi.waitUntil(() => model.inputs.length === 2);

  expect(lines(await untilAnswered(control, project, 1))).toEqual([
    { role: "user", text: "hello" },
    { role: "assistant", text: "resumed answer" },
  ]);
});

test("a message sent while a run is busy is answered after the first", async () => {
  const first = held();
  const model = scriptModel(first.respond, says("second answer"));
  const control = await servingGeneration1("generation-1-follow-up", new ProjectWorkspace());

  await submitted(control, project, "first", "r1");
  await vi.waitUntil(() => model.inputs.length === 1);
  await submitted(control, project, "second", "r2");
  first.release(says("first answer"));

  expect(lines(await untilAnswered(control, project, 2))).toEqual([
    { role: "user", text: "first" },
    { role: "assistant", text: "first answer" },
    { role: "user", text: "second" },
    { role: "assistant", text: "second answer" },
  ]);
  expect(model.inputs[1], "the second request carries the first exchange").toHaveLength(3);
});

test("a fresh thread is a new conversation that does not see the old messages", async () => {
  const model = scriptModel(says("old answer"), says("new answer"));
  const control = await servingGeneration1("generation-1-fresh", new ProjectWorkspace());

  await submitted(control, project, "old message", "r1");
  await untilAnswered(control, project, 1);

  expect(await control.freshProjectConversation(project)).toMatchObject({ ok: true });
  await submitted(control, project, "new message", "r2");

  expect(lines(await untilAnswered(control, project, 1))).toEqual([
    { role: "user", text: "new message" },
    { role: "assistant", text: "new answer" },
  ]);
  expect(model.inputs[1], "the new conversation sends only its own message").toHaveLength(1);
});

test("a tool call reads the project's file through the project capability", async () => {
  const workspace = new ProjectWorkspace();
  workspace.seedFile(`/workspace/projects/${project}/notes.txt`, "kept in the workspace\n");
  scriptModel(calls("read", { path: "notes.txt" }), says("read it"));
  const control = await servingGeneration1("generation-1-tool", workspace);

  await submitted(control, project, "read notes.txt", "r1");

  expect(lines(await untilAnswered(control, project, 1))).toEqual([
    { role: "user", text: "read notes.txt" },
    { role: "assistant", text: "" },
    { role: "toolResult", text: "kept in the workspace\n" },
    { role: "assistant", text: "read it" },
  ]);
});

test("an abort kills the command a tool is running and answers", async () => {
  const workspace = new ProjectWorkspace();
  workspace.seedFile(`/workspace/projects/${project}/notes.txt`, "");
  scriptModel(calls("bash", { command: "sleep 120" }));
  const control = await servingGeneration1("generation-1-abort-tool", workspace);

  await submitted(control, project, "run sleep 120", "r1");
  await vi.waitUntil(() => workspace.execs.handles.length === 1, { timeout: 10_000 });
  const aborted = control.abortProjectRun(project);

  await vi.waitUntil(() => workspace.execs.handles[0]?.killCalls === 1, { timeout: 5_000 });
  expect(await aborted).toEqual({ ok: true });
});

test("an abort answers while a command that ignores its kill still runs", async () => {
  const workspace = new ProjectWorkspace();
  workspace.killsCommands = false;
  workspace.seedFile(`/workspace/projects/${project}/notes.txt`, "");
  scriptModel(calls("bash", { command: "sleep 120" }));
  const control = await servingGeneration1("generation-1-abort-unkillable", workspace);

  await submitted(control, project, "run sleep 120", "r1");
  await vi.waitUntil(() => workspace.execs.handles.length === 1, { timeout: 10_000 });

  expect(await control.abortProjectRun(project)).toEqual({ ok: true });
});
