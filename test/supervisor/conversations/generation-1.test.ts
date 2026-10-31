import { env } from "cloudflare:workers";
import { reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, test, vi } from "vitest";
import { SERVING_FACET_NAME } from "../../../src/supervisor/artifacts/index.js";
import { sentMessage } from "../../../src/page/client/sent-message.js";
import { sampleProjectOne } from "../../project-fixtures.js";
import { ownerApiResponse } from "../../routes/helpers.js";
import {
  answeredLines,
  servingGeneration1,
  submitted,
  untilAnswered,
} from "./generation-1-session.js";
import { ProjectWorkspace } from "./project-workspace.js";
import { calls, held, says, scriptModel } from "./scripted-model.js";

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

  const control = env.SUPERVISOR.getByName("generation-1-resume");

  expect(await runDurableObjectAlarm(control)).toBe(true);
  await vi.waitUntil(() => model.inputs.length === 2);

  expect(await answeredLines(control, project, 1)).toEqual([
    { role: "user", text: "hello" },
    { role: "assistant", text: "resumed answer" },
  ]);
});

test("the owner API answers a sent message with the number the page accepts", async () => {
  scriptModel(says("an answer"));
  const control = await servingGeneration1("generation-1-send-answer", new ProjectWorkspace());

  const response = await ownerApiResponse(
    new Request(`https://cf-stumble.test/api/projects/${project}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: "hello", requestId: "r1" }),
    }),
    control,
  );

  expect(response.status).toBe(202);
  expect(sentMessage(await response.json())._tag).toBe("Some");
});

test("a message sent while a run is busy is answered after the first", async () => {
  const first = held();
  const model = scriptModel(first.respond, says("second answer"));
  const control = await servingGeneration1("generation-1-follow-up", new ProjectWorkspace());

  await submitted(control, project, "first", "r1");
  await vi.waitUntil(() => model.inputs.length === 1);
  await submitted(control, project, "second", "r2");
  first.release(says("first answer"));

  expect(await answeredLines(control, project, 2)).toEqual([
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

  expect(await answeredLines(control, project, 1)).toEqual([
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

  expect(await answeredLines(control, project, 1)).toEqual([
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

test("an idle events stream writes a line now and then, so a reader that left is noticed", async () => {
  scriptModel();
  const control = await servingGeneration1("generation-1-events-idle", new ProjectWorkspace());
  const opened = await control.projectEvents(project);

  if (!opened.ok) throw new Error(`the events must open: ${opened.problem.code}`);
  const reader = opened.events.pipeThrough(new TextDecoderStream()).getReader();
  let read = "";

  try {
    while (!read.endsWith("\n\n")) {
      const next = await reader.read();

      if (next.done) throw new Error("the event stream ended");
      read += next.value;
    }
  } finally {
    await reader.cancel();
  }

  expect(read.split("\n")[0]).toContain('"type":"snapshot"');
});

test("a fresh thread ends the events stream open on the old conversation", async () => {
  scriptModel();
  const control = await servingGeneration1("generation-1-events-fresh", new ProjectWorkspace());
  const opened = await control.projectEvents(project);

  if (!opened.ok) throw new Error(`the events must open: ${opened.problem.code}`);
  const reader = opened.events.getReader();
  await reader.read();

  expect(await control.freshProjectConversation(project)).toMatchObject({ ok: true });

  while (!(await reader.read()).done);
});

test("an events stream whose facet was replaced ends, and a fresh thread still answers", async () => {
  scriptModel();
  const control = await servingGeneration1("generation-1-events-replaced", new ProjectWorkspace());
  const opened = await control.projectEvents(project);

  if (!opened.ok) throw new Error(`the events must open: ${opened.problem.code}`);
  const reader = opened.events.getReader();
  await reader.read();

  await runInDurableObject(control, (_instance, state) => {
    state.facets.abort(SERVING_FACET_NAME, "another generation serves");
  });

  while (!(await reader.read()).done);
  expect(await control.freshProjectConversation(project)).toMatchObject({ ok: true });
});
