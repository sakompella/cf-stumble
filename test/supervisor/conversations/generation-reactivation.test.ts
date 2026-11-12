import { env, exports as workerExports } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, test, vi } from "vitest";
import { GENERATION_REPLACED } from "../../../src/generation-replaced.js";
import { sampleProjectOne } from "../../project-fixtures.js";
import { builtGeneration } from "../../facet/generation-1/built-module-map.js";
import {
  activateGeneration,
  generationLabel,
  prepareWithModuleMap,
  submitCandidate,
} from "../helpers.js";
import {
  answeredLines,
  commitNamed,
  servingGeneration1,
  submitted,
} from "./generation-1-session.js";
import { ProjectWorkspace } from "./project-workspace.js";
import { held, says, scriptModel } from "./scripted-model.js";

const project = sampleProjectOne.id;

type Control = Awaited<ReturnType<typeof servingGeneration1>>;

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

async function activateAnother(control: Control, name: string): Promise<number> {
  const other = await commitNamed(name);
  const label = await submitCandidate(control, other);
  await prepareWithModuleMap(control, label, await builtGeneration(other));

  return activateGeneration(control, label);
}

function servingInstance(control: Control): Promise<number> {
  return runInDurableObject(
    control,
    (_instance, state) => state.storage.kv.get<number>("serving-instance") ?? 0,
  );
}

test("a generation activated again after another one served still gets its model turns admitted", async () => {
  const model = scriptModel(says("before"), says("after"));
  const control = await servingGeneration1("reactivated-generation", new ProjectWorkspace());

  await submitted(control, project, "first", "r1");
  await model.asked(1);
  await answeredLines(control, project, 1);

  await activateAnother(control, "reactivated-generation-other");
  await activateGeneration(control, 0);

  await submitted(control, project, "second", "r2");
  await model.asked(2);
  await answeredLines(control, project, 2);

  expect(model.inputs).toHaveLength(2);
});

test("a rollback to a generation that served before gets a fresh model capability, and the replaced instance's capability is refused", async () => {
  const name = "rolled-back-generation";
  const model = scriptModel(says("before"), says("after"));
  const control = await servingGeneration1(name, new ProjectWorkspace());

  await submitted(control, project, "first", "r1");
  await model.asked(1);
  await answeredLines(control, project, 1);
  const replaced = await servingInstance(control);

  const epoch = await activateAnother(control, "rolled-back-generation-other");

  const rolledBack = await control.controlGeneration({
    kind: "rollback",
    label: generationLabel(0),
    observedEpoch: epoch,
  });

  expect(rolledBack.ok && rolledBack.outcome.kind).toBe("rolled-back");

  await submitted(control, project, "second", "r2");
  await model.asked(2);
  await answeredLines(control, project, 2);

  const stale = workerExports.ModelRoute({ props: { supervisor: name, instance: replaced } });

  expect(await stale.runStream({ messages: [{ role: "user", content: "hi" }] })).toEqual({
    ok: false,
    error: { code: "invalid-request", reason: GENERATION_REPLACED },
  });
  expect(model.inputs).toHaveLength(2);
});

test("a turn cut off by a Supervisor restart resumes with the restarted Supervisor's model capability", async () => {
  const name = "restarted-supervisor";
  const cutOff = held();
  const model = scriptModel(cutOff.respond, says("after the restart"));
  const control = await servingGeneration1(name, new ProjectWorkspace());

  await submitted(control, project, "first", "r1");
  await model.asked(1);

  await expect(
    runInDurableObject(control, (_instance, state) => {
      state.abort("the platform reset the Supervisor");
    }),
  ).rejects.toThrow();
  cutOff.release(says("before the restart"));

  const restarted = env.SUPERVISOR.getByName(name);

  expect(await answeredLines(restarted, project, 1)).toContainEqual({
    role: "assistant",
    text: "after the restart",
  });
  expect(model.inputs).toHaveLength(2);
});
