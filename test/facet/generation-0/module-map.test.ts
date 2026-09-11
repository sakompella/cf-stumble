/// <reference types="@cloudflare/vitest-plugin/types" />

import { env, exports as workerExports } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import { loadMainFacet } from "../../../src/facet/index.js";
import { parseHarnessCommit } from "../../../src/harness-commit.js";
import { moduleMapFromBuildOutput } from "../../../src/supervisor/artifacts/index.js";
import { submitCandidate } from "../../supervisor/helpers.js";
import type { BuiltModuleMapFile } from "../../../src/supervisor/artifacts/index.js";
import type { ModelCapability } from "../../../src/facet/generation-0/index.js";

/**
 * `pnpm build:module-map` writes this file, and `pnpm verify` runs that build before the tests.
 * Vite resolves the glob at build time, so this reads no filesystem and runs in workerd.
 */
declare global {
  interface ImportMeta {
    glob: (
      pattern: string,
      options: { readonly eager: true; readonly query: "?raw"; readonly import: "default" },
    ) => Record<string, string>;
  }
}

const builtFile = Object.values(
  import.meta.glob("../../../build/module-map.json", {
    eager: true,
    query: "?raw",
    import: "default",
  }),
).at(0);

/** A labeled harness commit for the built map. The build states no commit of its own. */
const GENERATION_0_COMMIT = "c0de00000000000000000000000000000000c0de";

function builtModuleMap(): Promise<BuiltModuleMapFile> {
  expect(builtFile, "run pnpm build:module-map before the tests").toBeDefined();

  // `Response.json` decodes the build output without asserting a shape it has not proved yet.
  return new Response(builtFile ?? "").json<BuiltModuleMapFile>();
}

afterEach(async () => {
  await reset();
});

test("the build writes an entry module and its modules, and no harness commit", async () => {
  const built = await builtModuleMap();

  expect(Object.keys(built).toSorted()).toEqual(["entryModule", "modules"]);
  expect(built.entryModule).toBe("main-facet.js");
  expect(built.modules.map((module) => module.name)).toEqual(["main-facet.js"]);
  expect(built.modules[0]?.source).toContain("MainFacet");
});

test("the written file parses into a module map the Supervisor build path accepts", async () => {
  const harnessCommit = parseHarnessCommit(GENERATION_0_COMMIT);
  expect(harnessCommit).toBeDefined();

  if (harnessCommit === undefined) return;

  const validated = moduleMapFromBuildOutput(harnessCommit, await builtModuleMap());
  expect(validated.isOk()).toBe(true);

  if (validated.isErr()) return;

  expect(validated.value.harnessCommit).toBe(GENERATION_0_COMMIT);

  const modelRoute = workerExports.ModelRoute({});
  const loaded = loadMainFacet(env.LOADER, validated.value, { MODEL: modelRoute });
  expect(loaded.isOk(), "the built module map must load through the facet loader").toBe(true);
});

test("a cold facet from the built module map passes the GET / startup check", async () => {
  const harnessCommit = parseHarnessCommit(GENERATION_0_COMMIT);

  if (harnessCommit === undefined) throw new Error("the test commit must be a Git object ID");
  const validated = moduleMapFromBuildOutput(harnessCommit, await builtModuleMap());

  if (validated.isErr())
    throw new Error(`the built module map must validate: ${validated.error.code}`);

  const control = env.SUPERVISOR.getByName("generation-0-module-map");
  const label = await submitCandidate(control, GENERATION_0_COMMIT);
  const checked = await control.checkGenerationStartup(label, validated.value);

  expect(checked.ok).toBe(true);

  if (!checked.ok) return;
  expect(checked.report.stage).toBe("ready");
  expect(checked.report.stage === "ready" && checked.report.status).toBeLessThan(400);
  expect(checked.report.generation).toMatchObject({ label, status: "ready" });
});

test("the host model route satisfies the capability the facet declares", () => {
  const modelRoute = workerExports.ModelRoute({});
  const capability: ModelCapability = modelRoute;

  expect(capability.run).toBeTypeOf("function");
});
