import { reset, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, test, vi } from "vitest";
import {
  activateGeneration,
  artifact,
  connectedSupervisor,
  prepareWithModuleMap,
  submitCandidate,
  FACET_COMPATIBILITY_METHOD,
  ANSWER_STARTUP_CHECK,
  generationLabel,
} from "../helpers.js";
import type { Supervisor } from "../../../src/supervisor/supervisor.js";

afterEach(async () => {
  await reset();
});

const SCRIPTED_COMMITS = [
  "d0d0000000000000000000000000000000000001",
  "d0d0000000000000000000000000000000000002",
] as const;

function scriptedFacet(harnessCommit: string): string {
  return `
import { DurableObject } from "cloudflare:workers";
export class MainFacet extends DurableObject {
  ${FACET_COMPATIBILITY_METHOD}
  fetch() { return new Response("ready"); }
  async attach(host) {
    const refusals = this.ctx.storage.kv.get("refuse-attach") ?? 0;
    if (refusals > 0) {
      this.ctx.storage.kv.put("refuse-attach", refusals - 1);
      throw new Error("attach refused");
    }
    this.host ??= host.dup();
  }
  async createConversation(cwd) {
    const created = (this.ctx.storage.kv.get("created") ?? 0) + 1;
    this.ctx.storage.kv.put("created", created);
    return "conversation:" + cwd + ":" + created;
  }
  async submit(conversationId, content) {
    if (content === "refuse the next attach") this.ctx.storage.kv.put("refuse-attach", 1);
    await this.host.running([{ conversationId }]);
    if (content === "fail the run") await this.host.running([], { [conversationId]: "model_error" });
    await this.host.arm({ active: true });
    const submitted = (this.ctx.storage.kv.get("submitted") ?? 0) + 1;
    this.ctx.storage.kv.put("submitted", submitted);
    return submitted;
  }
  async abort() {
    await this.host.running([]);
    await this.host.arm({ active: false });
  }
  async events(conversationId) {
    ${ANSWER_STARTUP_CHECK}
    return new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode("${harnessCommit}"));
        c.close();
      },
    });
  }
}
`;
}

async function readyScripted(
  control: DurableObjectStub<Supervisor>,
  harnessCommit: string,
): Promise<number> {
  const label = await submitCandidate(control, harnessCommit);
  await prepareWithModuleMap(control, label, artifact(harnessCommit, scriptedFacet(harnessCommit)));

  return label;
}

async function servingScripted(name: string): Promise<DurableObjectStub<Supervisor>> {
  const control = await connectedSupervisor(name);
  await activateGeneration(control, await readyScripted(control, SCRIPTED_COMMITS[0]));

  return control;
}

function alarm(control: DurableObjectStub<Supervisor>): Promise<number | null> {
  return runInDurableObject(control, (_instance, state) => state.storage.getAlarm());
}

async function admitted(
  control: DurableObjectStub<Supervisor>,
  projectId: string,
  content: string,
  requestId: string,
): Promise<number> {
  const result = await control.submitProjectMessage(projectId, content, requestId);

  if (!result.ok) throw new Error(`the message must be admitted: ${result.problem.code}`);

  return result.submissionId;
}

function conversationOf(
  control: DurableObjectStub<Supervisor>,
  projectId: string,
): Promise<string | undefined> {
  return runInDurableObject(
    control,
    (_instance, state) =>
      state.storage.sql
        .exec<{ conversation_id: string }>(
          "SELECT conversation_id FROM project_conversations WHERE project_id = ?",
          projectId,
        )
        .toArray()[0]?.conversation_id,
  );
}

async function servingCommit(
  control: DurableObjectStub<Supervisor>,
  projectId: string,
): Promise<string> {
  const result = await control.projectEvents(projectId);

  if (!result.ok) throw new Error(`the events must open: ${result.problem.code}`);

  return new Response(result.events).text();
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

  expect(await control.submitProjectMessage("sample-project-one", "  ", "r1")).toEqual({
    ok: false,
    problem: { code: "invalid-message" },
  });
  expect(await control.submitProjectMessage("project-nine", "hello", "r1")).toEqual({
    ok: false,
    problem: { code: "unknown-project-id" },
  });
});

test("a Supervisor with nothing serving refuses a message", async () => {
  const control = await connectedSupervisor("conversations-no-generation");

  expect(await control.submitProjectMessage("sample-project-one", "hello", "r1")).toEqual({
    ok: false,
    problem: { code: "no-active-generation" },
  });
});

test("an active run keeps the recovery alarm armed and refuses a workspace reset until it settles", async () => {
  const control = await servingScripted("conversations-alarm");
  const before = Date.now();
  const log = vi.spyOn(console, "log").mockImplementation(() => {});

  await control.submitProjectMessage("sample-project-one", "hello", "r1");

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

test("a run the facet reports as failed settles as failed with the error code", async () => {
  const control = await servingScripted("conversations-failed-run");
  const log = vi.spyOn(console, "log").mockImplementation(() => {});

  await control.submitProjectMessage("sample-project-one", "fail the run", "r1");

  expect(log).toHaveBeenCalledWith(
    expect.objectContaining({ event: "run.settled", outcome: "failed", errorCode: "model_error" }),
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

  await control.submitProjectMessage("harness", "refuse the next attach", "r1");

  await expect(runInDurableObject(control, (instance) => instance.alarm())).rejects.toThrow();
  await expect(
    runInDurableObject(control, (instance) => instance.alarm()),
  ).resolves.toBeUndefined();
  expect(await alarm(control)).not.toBeNull();
});
