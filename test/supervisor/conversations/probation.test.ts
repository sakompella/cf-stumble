import { env } from "cloudflare:workers";
import { reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, test, vi } from "vitest";
import {
  activateGeneration,
  artifact,
  connectedSupervisor,
  generationLabel,
  prepareWithModuleMap,
  submitCandidate,
  FACET_COMPATIBILITY_METHOD,
  ANSWER_STARTUP_CHECK,
  historyEventText,
} from "../helpers.js";
import type { Supervisor } from "../../../src/supervisor/supervisor.js";
import { PROJECT_RUN_DEADLINE_MS } from "../../../src/turn-budget.js";

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await reset();
});

const WORKING = "a0a0000000000000000000000000000000000001";

const BROKEN = "a0a0000000000000000000000000000000000002";

const SOUND = "a0a0000000000000000000000000000000000003";

function facet(harnessCommit: string, failure: string | null): string {
  return `
import { DurableObject } from "cloudflare:workers";
export class MainFacet extends DurableObject {
  ${FACET_COMPATIBILITY_METHOD}
  fetch() { return new Response("ready"); }
  async attach(host, model) { this.host ??= host.dup(); this.model ??= model; }
  async createConversation(cwd) { return "conversation:" + cwd; }
  async submit(conversationId, content) {
    if (content === "hold") {
      await this.host.running([{ conversationId }]);
      return 1;
    }
    if (content === "ask") {
      await this.host.running([{ conversationId }]);
      const reply = await this.model.runStream({ messages: [{ role: "user", content }] });
      await reply.cancel();
      return 1;
    }
    if (content === "numbered") {
      await this.host.running([{ conversationId }]);
      await this.host.running([{ conversationId, run: 1 }]);
      return 1;
    }
    if (content === "end") {
      await this.host.running([], { [conversationId]: "faulted" });
      return 1;
    }
    const failure = content === "fail" ? "model_error" : content === "crash" ? "faulted" : ${JSON.stringify(failure)};
    await this.host.running([{ conversationId }]);
    await this.host.running([], failure === null ? {} : { [conversationId]: failure });
    return 1;
  }
  async abort(conversationId, reason) {
    if (reason === "deadline") await this.host.running([]);
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

async function ready(
  control: DurableObjectStub<Supervisor>,
  harnessCommit: string,
  failure: string | null,
): Promise<number> {
  const label = await submitCandidate(control, harnessCommit);
  await prepareWithModuleMap(
    control,
    label,
    artifact(harnessCommit, facet(harnessCommit, failure)),
  );

  return label;
}

async function send(
  control: DurableObjectStub<Supervisor>,
  requestId: string,
  content = "hello",
): Promise<void> {
  await control.submitProjectMessage("sample-project-one", content, requestId);
}

async function serving(control: DurableObjectStub<Supervisor>): Promise<string> {
  const result = await control.projectEvents("sample-project-one");

  if (!result.ok) throw new Error(`the events must open: ${result.problem.code}`);

  return new Response(result.events).text();
}

async function provenThenActivated(name: string, harnessCommit: string, failure: string | null) {
  const control = await connectedSupervisor(name);
  const working = await ready(control, WORKING, null);
  await activateGeneration(control, working);
  await send(control, "r1");
  await activateGeneration(control, await ready(control, harnessCommit, failure));

  return { control, working };
}

test("a generation whose first real turn fails is rolled back to the last generation that completed one", async () => {
  const { control, working } = await provenThenActivated("probation-rollback", BROKEN, "faulted");

  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

  const { epoch: activated, generation } = await control.getActiveGeneration();
  await send(control, "r2");

  expect((await control.getActiveGeneration()).generation?.label).toBe(working);
  expect(JSON.parse(await historyEventText(`${activated}-activated`))).toMatchObject({
    actor: "owner",
  });
  expect(JSON.parse(await historyEventText(`${activated}-probation-failed`))).toMatchObject({
    actor: "probation",
    label: generation?.label,
    errorCode: "faulted",
  });
  expect(JSON.parse(await historyEventText(`${activated + 1}-rolled-back`))).toMatchObject({
    actor: "probation",
    label: working,
  });
  expect(warn).toHaveBeenCalledWith(
    expect.objectContaining({
      event: "generation.probation-failed",
      fallback: working,
      errorCode: "faulted",
      refused: null,
    }),
  );
  expect(await serving(control)).toBe(WORKING);

  log.mockClear();
  await send(control, "r3");

  expect(log).toHaveBeenCalledWith(
    expect.objectContaining({ event: "run.settled", generation: working, outcome: "completed" }),
  );
});

test("a completed turn ends probation, so a later failed turn keeps the generation", async () => {
  const { control } = await provenThenActivated("probation-passed", SOUND, null);
  const { epoch, generation } = await control.getActiveGeneration();
  const activated = generation?.label;

  await send(control, "r2");

  expect(JSON.parse(await historyEventText(`${epoch}-proven`))).toMatchObject({
    kind: "proven",
    actor: "probation",
    label: activated,
    outcome: "completed",
  });

  await send(control, "r3", "fail");

  expect((await control.getActiveGeneration()).generation?.label).toBe(activated);
});

test("a model error on a generation's first turn keeps it on probation, and a later fault still rolls it back", async () => {
  const { control, working } = await provenThenActivated("probation-model-error", SOUND, null);
  const activated = (await control.getActiveGeneration()).generation?.label;
  vi.spyOn(console, "warn").mockImplementation(() => {});

  await send(control, "r2", "fail");
  expect((await control.getActiveGeneration()).generation?.label).toBe(activated);

  await send(control, "r3", "crash");
  expect((await control.getActiveGeneration()).generation?.label).toBe(working);
});

async function activeLabel(control: DurableObjectStub<Supervisor>): Promise<number | undefined> {
  return (await control.getActiveGeneration()).generation?.label;
}

test("an owner cancel survives a Supervisor restart, so the run's end does not roll back the generation on probation", async () => {
  const name = "probation-cancel-restart";
  const { control } = await provenThenActivated(name, SOUND, null);
  const activated = await activeLabel(control);

  await send(control, "r2", "hold");
  await control.abortProjectRun("sample-project-one");
  await expect(
    runInDurableObject(control, (_instance, state) => {
      state.abort("the platform reset the Supervisor");
    }),
  ).rejects.toThrow();

  const restarted = env.SUPERVISOR.getByName(name);
  await send(restarted, "r3", "end");

  expect(await activeLabel(restarted)).toBe(activated);
});

test("a run reported first without its number and then with it stays one run, so it proves nothing early", async () => {
  const { control, working } = await provenThenActivated("probation-run-number", SOUND, null);
  vi.spyOn(console, "warn").mockImplementation(() => {});

  await send(control, "r2", "numbered");
  await send(control, "r3", "end");

  expect(await activeLabel(control)).toBe(working);
});

test("an owner activation is refused while a run is in flight", async () => {
  const { control, working } = await provenThenActivated("probation-activation-busy", SOUND, null);
  const { epoch } = await control.getActiveGeneration();

  await send(control, "r2", "hold");

  expect(
    await control.controlGeneration({
      kind: "rollback",
      label: generationLabel(working),
      observedEpoch: epoch,
    }),
  ).toEqual({ ok: false, problem: { code: "run-active" } });
});

async function pastDeadline(control: DurableObjectStub<Supervisor>): Promise<void> {
  vi.setSystemTime(Date.now() + PROJECT_RUN_DEADLINE_MS + 1_000);
  await runDurableObjectAlarm(control);
}

test("a run stopped at its deadline fails probation only when its generation never asked the model", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const { control, working } = await provenThenActivated("probation-deadline", SOUND, null);
  const activated = await activeLabel(control);
  const { epoch } = await control.getActiveGeneration();
  vi.spyOn(console, "warn").mockImplementation(() => {});

  await send(control, "r2", "ask");
  await pastDeadline(control);

  expect(await activeLabel(control)).toBe(activated);

  await send(control, "r3", "hold");
  await pastDeadline(control);

  expect(await activeLabel(control)).toBe(working);
  expect(JSON.parse(await historyEventText(`${epoch}-probation-failed`))).toMatchObject({
    label: activated,
    outcome: "stalled",
  });
});

test("a run cut off by a Supervisor restart before it asked the model does not fail probation at its deadline", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const name = "probation-deadline-restart";
  const { control } = await provenThenActivated(name, SOUND, null);
  const activated = await activeLabel(control);

  await send(control, "r2", "hold");
  vi.setSystemTime(Date.now() + 1_000);
  await expect(
    runInDurableObject(control, (_instance, state) => {
      state.abort("the platform reset the Supervisor");
    }),
  ).rejects.toThrow();

  const restarted = env.SUPERVISOR.getByName(name);
  await pastDeadline(restarted);

  expect(await activeLabel(restarted)).toBe(activated);
});
