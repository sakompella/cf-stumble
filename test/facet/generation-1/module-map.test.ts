import { env, exports as workerExports } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import { prepareWithModuleMap, submitCandidate } from "../../supervisor/helpers.js";
import type { ModelCapability } from "../../../src/facet/generation-1/capabilities.js";
import { builtGeneration } from "./built-module-map.js";

const GENERATION_1_COMMIT = "c0de00000000000000000000000000000000c0d1";

afterEach(async () => {
  await reset();
});

test("the built generation passes the Supervisor's startup check", async () => {
  const control = env.SUPERVISOR.getByName("generation-1-module-map");
  const label = await submitCandidate(control, GENERATION_1_COMMIT);
  const moduleMap = await builtGeneration(GENERATION_1_COMMIT);
  const checked = await prepareWithModuleMap(control, label, moduleMap);

  expect(checked).toMatchObject({
    ok: true,
    report: { stage: "ready", generation: { label, status: "ready" } },
  });
});

test("the host model route satisfies the capability the facet declares", async () => {
  const modelRoute = workerExports.ModelRoute({});
  const capability: ModelCapability = modelRoute;

  await expect(capability.runStream({ messages: [] })).resolves.toEqual({
    ok: false,
    error: { code: "invalid-request", reason: "messages must be a non-empty array" },
  });
});
