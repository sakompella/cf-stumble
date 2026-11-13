import { reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, test, vi } from "vitest";
import { activateGeneration, connectedSupervisor, generationLabel } from "../helpers.js";
import type { Supervisor } from "../../../src/supervisor/supervisor.js";
import { PROJECT_RUN_DEADLINE_MS } from "../../../src/turn-budget.js";
import { readyScripted, SCRIPTED_COMMITS, servingScripted } from "./serving-fixture.js";

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await reset();
});

function alarm(control: DurableObjectStub<Supervisor>): Promise<number | null> {
  return runInDurableObject(control, (_instance, state) => state.storage.getAlarm());
}

async function admitted(
  control: DurableObjectStub<Supervisor>,
  projectId: string,
  content: string,
  requestId: string,
): Promise<number> {
  const result = await control.submitProjectMessage(projectId, content, requestId, 30);

  if (!result.ok) throw new Error(`the message must be admitted: ${result.problem.code}`);

  return result.submissionId;
}

async function conversationOf(
  control: DurableObjectStub<Supervisor>,
  projectId: string,
): Promise<string | undefined> {
  const result = await control.projectEvents(projectId);

  if (!result.ok) throw new Error(`the events must open: ${result.problem.code}`);

  return (await new Response(result.events).text()).split("|")[1];
}

async function servingCommit(
  control: DurableObjectStub<Supervisor>,
  projectId: string,
): Promise<string> {
  const result = await control.projectEvents(projectId);

  if (!result.ok) throw new Error(`the events must open: ${result.problem.code}`);

  return (await new Response(result.events).text()).split("|")[0] ?? "";
}

test("a project's first message creates its conversation in the project directory, and later ones reuse it", async () => {
  const control = await servingScripted("conversations-first-message");

  expect(await admitted(control, "sample-project-one", "hello", "r1")).toBe(1);

  const first = await conversationOf(control, "sample-project-one");

  expect(await admitted(control, "sample-project-one", "again", "r2")).toBe(2);

  const second = await conversationOf(control, "sample-project-one");

  await admitted(control, "harness", "hi", "r3");

  const harness = await conversationOf(control, "harness");

  expect(first?.startsWith("conversation:/workspace/projects/sample-project-one:")).toBe(true);
  expect(second).toBe(first);
  expect(harness?.startsWith("conversation:/workspace/harness:")).toBe(true);
});

test("a message that is not a message reaches no generation", async () => {
  const control = await servingScripted("conversations-invalid-message");

  expect(await control.submitProjectMessage("sample-project-one", "  ", "r1", 30)).toEqual({
    ok: false,
    problem: { code: "invalid-message" },
  });
  expect(await control.submitProjectMessage("project-nine", "hello", "r1", 30)).toEqual({
    ok: false,
    problem: { code: "unknown-project-id" },
  });
});

test("a Supervisor with nothing serving refuses a message", async () => {
  const control = await connectedSupervisor("conversations-no-generation");

  expect(await control.submitProjectMessage("sample-project-one", "hello", "r1", 30)).toEqual({
    ok: false,
    problem: { code: "no-active-generation" },
  });
});

test("an active run keeps the recovery alarm armed and refuses a workspace reset until it settles", async () => {
  const control = await servingScripted("conversations-alarm");
  const before = Date.now();
  const log = vi.spyOn(console, "log").mockImplementation(() => {});

  await control.submitProjectMessage("sample-project-one", "hello", "r1", 30);

  const armed = await alarm(control);
  expect(armed).toBeGreaterThan(before);
  expect(armed).toBeLessThanOrEqual(Date.now() + 60_000);
  expect(await control.resetWorkspace()).toEqual({ ok: false, problem: { code: "run-active" } });

  await control.abortProjectRun("sample-project-one");

  expect(await alarm(control)).toBeNull();
  expect(log).toHaveBeenCalledWith(
    expect.objectContaining({ event: "run.settled", outcome: "cancelled" }),
  );
});

test("a run the facet continues at its deadline gets its own deadline and workspace at once, so the next alarm does not abort it", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const control = await servingScripted("conversations-continued-at-deadline");
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

  const events = (spy: typeof log, event: string) =>
    spy.mock.calls.filter(([line]) => JSON.stringify(line).includes(`"event":"${event}"`));

  await admitted(control, "sample-project-one", "continue at the deadline", "r1");
  vi.setSystemTime(Date.now() + PROJECT_RUN_DEADLINE_MS + 1_000);

  expect(await runDurableObjectAlarm(control)).toBe(true);
  await vi.waitUntil(() => events(log, "run.settled").length === 1);
  expect(await runDurableObjectAlarm(control)).toBe(true);

  expect(events(warn, "run.deadline-aborted")).toHaveLength(1);
  expect(log).toHaveBeenCalledWith(expect.objectContaining({ event: "run.settled", continues: 0 }));
  expect(events(log, "run.started")).toHaveLength(2);
  await vi.waitUntil(() => events(log, "facet.continued-workspace").length === 1);
  expect(log).not.toHaveBeenCalledWith(
    expect.objectContaining({ refused: "this conversation has no running project workspace" }),
  );
  expect(await control.resetWorkspace()).toEqual({ ok: false, problem: { code: "run-active" } });
});

test("a run the facet reports unanswered with a model error settles as unanswered with the error code", async () => {
  const control = await servingScripted("conversations-failed-run");
  const log = vi.spyOn(console, "log").mockImplementation(() => {});

  await control.submitProjectMessage("sample-project-one", "fail the run", "r1", 30);

  expect(log).toHaveBeenCalledWith(
    expect.objectContaining({
      event: "run.settled",
      outcome: "unanswered",
      errorCode: "model_error",
    }),
  );
});

test("an abort while nothing runs does not mark the next run cancelled", async () => {
  const control = await servingScripted("conversations-idle-abort");
  const log = vi.spyOn(console, "log").mockImplementation(() => {});

  await control.submitProjectMessage("sample-project-one", "fail the run", "r1", 30);
  await control.abortProjectRun("sample-project-one");
  log.mockClear();
  await control.submitProjectMessage("sample-project-one", "fail the run", "r2", 30);

  expect(log).toHaveBeenCalledWith(
    expect.objectContaining({
      event: "run.settled",
      outcome: "unanswered",
      errorCode: "model_error",
    }),
  );
});

test("activation and rollback replace the serving facet, and its storage carries over", async () => {
  const control = await servingScripted("conversations-generation-change");
  const [first, second] = SCRIPTED_COMMITS;
  const firstLabel = (await control.getActiveGeneration()).generation?.label ?? -1;

  expect(await servingCommit(control, "harness")).toBe(first);

  const secondLabel = await readyScripted(control, second);
  await activateGeneration(control, secondLabel);

  expect(await servingCommit(control, "harness")).toBe(second);

  const fresh = await control.freshProjectConversation("sample-project-one");
  expect(fresh.ok && fresh.conversationId.endsWith(":2")).toBe(true);

  const { epoch } = await control.getActiveGeneration();
  expect(
    await control.controlGeneration({
      kind: "rollback",
      label: generationLabel(firstLabel),
      observedEpoch: epoch,
    }),
  ).toMatchObject({ ok: true });

  expect(await servingCommit(control, "harness")).toBe(first);
});

test("an alarm whose attach fails throws, so the platform retries it, and the retry resumes the run", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const control = await servingScripted("conversations-alarm-retry");

  await control.submitProjectMessage("harness", "refuse the next attach", "r1", 30);

  await expect(runInDurableObject(control, (instance) => instance.alarm())).rejects.toThrow();
  await expect(
    runInDurableObject(control, (instance) => instance.alarm()),
  ).resolves.toBeUndefined();
  expect(await alarm(control)).not.toBeNull();
});

test("a message that was checked before its project was disconnected does not give the project a new conversation", async () => {
  const control = await servingScripted("conversations-disconnect-race", 200);

  const submitting = control.submitProjectMessage("sample-project-one", "hello", "r1", 30);
  const disconnecting = control.disconnectProject("sample-project-one");

  expect((await disconnecting).ok).toBe(true);
  expect(await submitting).toEqual({ ok: false, problem: { code: "unknown-project-id" } });
  expect(await conversationOf(control, "harness")).toBe("conversation:/workspace/harness:1");
});

test("an events stream the facet closes ends once its chunks are read, without cancelling the facet's stream", async () => {
  const control = await servingScripted("conversations-events-end");
  const log = vi.spyOn(console, "log").mockImplementation(() => {});

  expect(await servingCommit(control, "sample-project-one")).toBe(SCRIPTED_COMMITS[0]);
  expect(log).not.toHaveBeenCalledWith(
    expect.objectContaining({ event: "facet.events-cancelled" }),
  );
});

test("a reader that cancels its events stream cancels the facet's stream", async () => {
  const control = await servingScripted("conversations-events-cancel");
  const log = vi.spyOn(console, "log").mockImplementation(() => {});

  await admitted(control, "sample-project-one", "hold the events open", "r1");
  const result = await control.projectEvents("sample-project-one");

  if (!result.ok) throw new Error(`the events must open: ${result.problem.code}`);
  const reader = result.events.getReader();
  await reader.read();
  await reader.cancel();

  await vi.waitFor(() => {
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ event: "facet.events-cancelled" }));
  });
});
