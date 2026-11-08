import { reset } from "cloudflare:test";
import { afterEach, expect, test, vi } from "vitest";
import {
  activateGeneration,
  artifact,
  connectedSupervisor,
  prepareWithModuleMap,
  submitCandidate,
  FACET_COMPATIBILITY_METHOD,
  ANSWER_STARTUP_CHECK,
} from "../helpers.js";
import type { Supervisor } from "../../../src/supervisor/supervisor.js";

afterEach(async () => {
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
  async attach(host) { this.host ??= host.dup(); }
  async createConversation(cwd) { return "conversation:" + cwd; }
  async submit(conversationId, content) {
    const failure = content === "fail" ? "model_error" : ${JSON.stringify(failure)};
    await this.host.running([{ conversationId }]);
    await this.host.running([], failure === null ? {} : { [conversationId]: failure });
    return 1;
  }
  async abort() {}
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
  const { control, working } = await provenThenActivated(
    "probation-rollback",
    BROKEN,
    "storage_failed",
  );

  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

  await send(control, "r2");

  expect((await control.getActiveGeneration()).generation?.label).toBe(working);
  expect(warn).toHaveBeenCalledWith(
    expect.objectContaining({
      event: "generation.probation-failed",
      fallback: working,
      errorCode: "storage_failed",
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
  const activated = (await control.getActiveGeneration()).generation?.label;

  await send(control, "r2");
  await send(control, "r3", "fail");

  expect((await control.getActiveGeneration()).generation?.label).toBe(activated);
});
