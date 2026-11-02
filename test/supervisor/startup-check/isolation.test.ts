import { reset } from "cloudflare:test";
import { afterEach, expect, test, vi } from "vitest";
import { builtGeneration } from "../../facet/generation-1/built-module-map.js";
import { sampleProjectOne } from "../../project-fixtures.js";
import { prepareWithModuleMap, submitCandidate } from "../helpers.js";
import {
  answeredLines,
  commitNamed,
  servingGeneration1,
  submitted,
} from "../conversations/generation-1-session.js";
import { ProjectWorkspace } from "../conversations/project-workspace.js";
import { says, scriptModel } from "../conversations/scripted-model.js";

const project = sampleProjectOne.id;

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

test("a startup check talks to its own conversation and model, and the serving conversation goes on untouched", async () => {
  const model = scriptModel(says("first answer"), says("second answer"));
  const control = await servingGeneration1("startup-check-isolation", new ProjectWorkspace());

  await submitted(control, project, "first", "r1");
  const before = await answeredLines(control, project, 1);

  const next = await commitNamed("startup-check-isolation-next");
  const label = await submitCandidate(control, next);
  const checked = await prepareWithModuleMap(control, label, await builtGeneration(next));

  expect(checked).toMatchObject({ ok: true, report: { stage: "ready" } });

  await submitted(control, project, "second", "r2");

  expect(await answeredLines(control, project, 2)).toEqual([
    ...before,
    { role: "user", text: "second" },
    { role: "assistant", text: "second answer" },
  ]);
  expect(model.inputs, "only the serving conversation reached the production model").toHaveLength(
    2,
  );
});
