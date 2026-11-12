import { reset, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, test, vi } from "vitest";
import { OLD_PROTOCOL_COMPATIBILITY } from "../../../src/supervisor/artifacts/index.js";
import { sampleProjectOne } from "../../project-fixtures.js";
import { builtGeneration } from "../../facet/generation-1/built-module-map.js";
import {
  activateGeneration,
  generationLabel,
  prepareWithModuleMap,
  storeModuleMap,
  submitCandidate,
} from "../helpers.js";
import {
  answeredLines,
  commitNamed,
  grantedSupervisor,
  submitted,
} from "./generation-1-session.js";
import { ProjectWorkspace } from "./project-workspace.js";
import { says, scriptModel } from "./scripted-model.js";

const project = sampleProjectOne.id;

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

const ATTACH = /async attach\(host, (\w+), generations\) \{/u;

async function oldProtocolGeneration(harnessCommit: string) {
  const built = await builtGeneration(harnessCommit);

  return {
    ...built,
    modules: built.modules.map((module) => {
      if (!ATTACH.test(module.source)) return module;

      return {
        ...module,
        source: module.source
          .replace(ATTACH, "async attach(host, generations) { const $1 = this.env.MODEL;")
          .replace(/\/host-\d+`/u, "/host-5`"),
      };
    }),
  };
}

async function servingOldProtocol(name: string) {
  const control = await grantedSupervisor(name, new ProjectWorkspace());
  const commit = await commitNamed(name);

  await submitCandidate(control, commit);
  await storeModuleMap(await oldProtocolGeneration(commit));
  await runInDurableObject(control, (_instance, state) => {
    state.storage.sql.exec(
      "UPDATE generations SET status = 'ready', was_active = 1, facet_compatibility = ? WHERE label = 0",
      OLD_PROTOCOL_COMPATIBILITY,
    );
    state.storage.sql.exec(
      "UPDATE generation_state SET active_label = 0, proven_label = 0, epoch = 1 WHERE singleton = 1",
    );
  });

  return control;
}

test("an old-protocol generation keeps serving, writes the startup check of a new-protocol generation, and hands over its conversation", async () => {
  const model = scriptModel(says("from the old protocol"), says("from the new protocol"));
  const control = await servingOldProtocol("old-protocol-handover");

  await submitted(control, project, "first", "r1");
  await model.asked(1);

  const next = await commitNamed("old-protocol-handover-next");
  const label = await submitCandidate(control, next);
  const checked = await prepareWithModuleMap(control, label, await builtGeneration(next));

  expect(checked).toMatchObject({ ok: true, report: { stage: "ready" } });
  expect(model.inputs, "the startup check never reached the production model").toHaveLength(1);

  const epoch = await vi.waitFor(() => activateGeneration(control, label));

  await submitted(control, project, "second", "r2");
  await model.asked(2);

  expect(await answeredLines(control, project, 2)).toEqual(
    expect.arrayContaining([
      { role: "assistant", text: "from the old protocol" },
      { role: "assistant", text: "from the new protocol" },
    ]),
  );
  expect(
    await control.controlGeneration({
      kind: "rollback",
      label: generationLabel(0),
      observedEpoch: epoch,
    }),
  ).toEqual({ ok: false, problem: { code: "facet-compatibility-mismatch" } });
});
