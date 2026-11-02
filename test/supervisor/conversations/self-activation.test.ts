import { reset, runDurableObjectAlarm } from "cloudflare:test";
import { afterEach, expect, test, vi } from "vitest";
import { builtGeneration } from "../../facet/generation-1/built-module-map.js";
import { sampleProjectOne } from "../../project-fixtures.js";
import { prepareWithModuleMap, submitCandidate } from "../helpers.js";
import {
  answeredLines,
  commitNamed,
  servingGeneration1,
  submitted,
} from "./generation-1-session.js";
import { ProjectWorkspace } from "./project-workspace.js";
import { calls, says, scriptModel } from "./scripted-model.js";

const project = sampleProjectOne.id;

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

test("a conversation activates a prepared generation with stumble, and the new generation goes on with it", async () => {
  const control = await servingGeneration1("self-activation", new ProjectWorkspace());
  const next = await commitNamed("self-activation-next");
  const label = await submitCandidate(control, next);
  const checked = await prepareWithModuleMap(control, label, await builtGeneration(next));

  expect(checked).toMatchObject({ ok: true, report: { stage: "ready" } });

  const { epoch } = await control.getActiveGeneration();

  const model = scriptModel(
    calls("bash", { command: `stumble gen activate ${label} --epoch ${epoch}` }),
    calls("bash", { command: "stumble gen status" }),
    says("already active"),
  );

  await submitted(control, project, "activate it", "r1");
  await vi.waitUntil(
    async () => (await control.getActiveGeneration()).generation?.label === label,
    {
      timeout: 10_000,
    },
  );

  expect(model.inputs, "the replaced facet stops before its next model turn").toHaveLength(1);
  expect(await runDurableObjectAlarm(control)).toBe(true);

  const answered = await answeredLines(control, project, 1);

  expect(answered.slice(-2)).toEqual([
    {
      role: "toolResult",
      text: `active generation ${label} at ${next} (ready), epoch ${epoch + 1}\n`,
    },
    { role: "assistant", text: "already active" },
  ]);
});
