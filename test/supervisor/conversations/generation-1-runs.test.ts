import { env } from "cloudflare:workers";
import { reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, test, vi } from "vitest";
import { PROJECT_RUN_DEADLINE_MS } from "../../../src/turn-budget.js";
import { sampleProjectOne, sampleProjectTwo } from "../../project-fixtures.js";
import { hasRun, servingGeneration1, submitted, untilAnswered } from "./generation-1-session.js";
import { ProjectWorkspace } from "./project-workspace.js";
import { calls, held, says, scriptModel } from "./scripted-model.js";

const project = sampleProjectOne.id;

const otherProject = sampleProjectTwo.id;

const MINUTE_MS = 60_000;

function advanceSupervisorClock(ms: number): void {
  vi.setSystemTime(Date.now() + ms);
}

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await reset();
});

test("a run that starts in one project while another project runs gets its own full deadline", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const workspace = new ProjectWorkspace();
  workspace.seedFile(`/workspace/projects/${otherProject}/notes.txt`, "notes\n");
  const first = held();
  const model = scriptModel(first.respond, calls("read", { path: "notes.txt" }), says("read it"));
  const control = await servingGeneration1("generation-1-own-deadline", workspace);

  await submitted(control, project, "wait", "r1");
  await model.asked(1);
  advanceSupervisorClock(5 * MINUTE_MS);
  await submitted(control, otherProject, "read notes.txt", "r2");
  await untilAnswered(control, otherProject, 1);

  const budgets = workspace.leases.map((lease) => lease.remainingMs);
  expect(Math.min(...budgets)).toBeGreaterThan(PROJECT_RUN_DEADLINE_MS - MINUTE_MS);
  first.release(says("done"));
});

test("a project's capability ends when its run settles while another project's run goes on", async () => {
  const workspace = new ProjectWorkspace();
  workspace.seedFile(`/workspace/projects/${project}/notes.txt`, "notes\n");
  const other = held();
  const model = scriptModel(other.respond, calls("read", { path: "notes.txt" }), says("read it"));
  const control = await servingGeneration1("generation-1-capability-per-run", workspace);

  await submitted(control, otherProject, "wait", "r1");
  await model.asked(1);
  const othersLeases = workspace.leases.length;
  await submitted(control, project, "read notes.txt", "r2");
  await untilAnswered(control, project, 1);

  const ended = () => workspace.leases.map((lease) => lease.ended);
  await vi.waitUntil(() => ended().slice(othersLeases).every(Boolean), { timeout: 5_000 });
  expect(ended().slice(0, othersLeases)).not.toContain(true);
  expect(await hasRun(control, otherProject)).toBe(true);
  other.release(says("done"));
});

test("an alarm after a Supervisor reset aborts only the run past its own deadline", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const answers = [held(), held(), held(), held()];
  const model = scriptModel(...answers.map((answer) => answer.respond));

  const lost = await servingGeneration1(
    "generation-1-deadline-after-reset",
    new ProjectWorkspace(),
  );

  await submitted(lost, project, "first", "r1");
  await model.asked(1);
  advanceSupervisorClock(5 * MINUTE_MS);
  await submitted(lost, otherProject, "second", "r2");
  await model.asked(2);

  await expect(
    runInDurableObject(lost, (_instance, state) => {
      state.abort("the platform reset the Supervisor");
    }),
  ).rejects.toThrow();

  const control = env.SUPERVISOR.getByName("generation-1-deadline-after-reset");
  advanceSupervisorClock(PROJECT_RUN_DEADLINE_MS - 5 * MINUTE_MS + 1_000);

  expect(await runDurableObjectAlarm(control)).toBe(true);
  await vi.waitUntil(async () => !(await hasRun(control, project)), { timeout: 10_000 });
  expect(await hasRun(control, otherProject)).toBe(true);

  for (const answer of answers) answer.release(says("late"));
});
