import { reset } from "cloudflare:test";
import { afterEach, expect, test, vi } from "vitest";
import { sampleProjectOne } from "../../project-fixtures.js";
import { builtGeneration } from "../../facet/generation-1/built-module-map.js";
import { activateGeneration, prepareWithModuleMap, submitCandidate } from "../helpers.js";
import {
  answeredLines,
  commitNamed,
  servingGeneration1,
  submitted,
} from "./generation-1-session.js";
import { ProjectWorkspace } from "./project-workspace.js";
import { says, scriptModel } from "./scripted-model.js";

const project = sampleProjectOne.id;

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

test("a generation activated again after another one served still gets its model turns admitted", async () => {
  const model = scriptModel(says("before"), says("after"));
  const control = await servingGeneration1("reactivated-generation", new ProjectWorkspace());

  await submitted(control, project, "first", "r1");
  await model.asked(1);
  await answeredLines(control, project, 1);

  const other = await commitNamed("reactivated-generation-other");
  const label = await submitCandidate(control, other);
  await prepareWithModuleMap(control, label, await builtGeneration(other));
  await activateGeneration(control, label);
  await activateGeneration(control, 0);

  await submitted(control, project, "second", "r2");
  await model.asked(2);
  await answeredLines(control, project, 2);

  expect(model.inputs).toHaveLength(2);
});
