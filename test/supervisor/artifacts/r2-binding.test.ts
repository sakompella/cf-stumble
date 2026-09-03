/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import type { Supervisor } from "../../../src/supervisor/supervisor.js";
import { artifact, labelCandidate } from "../helpers.js";

const commit = "deadbeef0123456789abcdef0123456789abcdef";

function supervisor(name: string): DurableObjectStub<Supervisor> {
  return env.SUPERVISOR.getByName(name);
}

afterEach(async () => {
  await reset();
});

test("provides a local R2 module-map binding", async () => {
  await env.MODULE_MAPS.put("module-maps/fixture", "fixture module map");

  const object = await env.MODULE_MAPS.get("module-maps/fixture");

  if (object === null) {
    throw new Error("the seeded module-map object must be readable");
  }

  expect(await object.text()).toBe("fixture module map");
});

test("stores validated module maps in R2 and not Supervisor SQLite", async () => {
  const control = supervisor("r2-artifact-storage");
  const label = await labelCandidate(control, commit);
  const input = artifact(
    commit,
    `import { DurableObject } from "cloudflare:workers";
export class MainFacet extends DurableObject { fetch() { return new Response("r2"); } }`,
  );

  const result = await control.checkGenerationStartup(label, input);

  expect(result).toMatchObject({ ok: true, report: { stage: "ready" } });
  const object = await env.MODULE_MAPS.get(`module-maps/${commit}`);
  if (object === null) {
    throw new Error("the cached module map must be readable");
  }
  expect(JSON.parse(await object.text())).toEqual(input);

  const tables = await runInDurableObject(control, (_instance, state) =>
    state.storage.sql
      .exec<{ readonly name: string }>(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'harness_artifact_modules'",
      )
      .toArray(),
  );
  expect(tables).toEqual([]);
});

test("rebuilds a corrupt R2 object from the validated candidate", async () => {
  const control = supervisor("r2-artifact-corruption");
  const label = await labelCandidate(control, commit);
  const input = artifact(
    commit,
    `import { DurableObject } from "cloudflare:workers";
export class MainFacet extends DurableObject { fetch() { return new Response("rebuilt"); } }`,
  );
  await env.MODULE_MAPS.put(`module-maps/${commit}`, "not-json");

  const result = await control.checkGenerationStartup(label, input);

  expect(result).toMatchObject({ ok: true, report: { stage: "ready" } });
  const object = await env.MODULE_MAPS.get(`module-maps/${commit}`);
  if (object === null) {
    throw new Error("the cached module map must be readable");
  }
  expect(JSON.parse(await object.text())).toEqual(input);
});
