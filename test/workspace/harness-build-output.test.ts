import * as Effect from "effect/Effect";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import { HARNESS_BUILD_CONFIGURATION } from "../../src/harness-build.js";
import { testHarnessCommit } from "../harness-commit-fixtures.js";
import { executeHarnessBuildOutput } from "../../src/workspace/commands/build-harness.js";
import {
  operationsOverPublishedModuleMap,
  OUTPUT_LIMIT_BYTES,
  oversizedModuleMap,
} from "./module-map-container.js";

const commit = testHarnessCommit("7000000000000000000000000000000000000001");

test("a module map larger than the output limits arrives whole, through the workspace filesystem", async () => {
  await runInDurableObject(env.SUPERVISOR.getByName("build-output"), async (_instance, state) => {
    const operations = await operationsOverPublishedModuleMap(state, commit);

    const answered = await Effect.runPromise(
      executeHarnessBuildOutput({
        configuration: HARNESS_BUILD_CONFIGURATION,
        operations,
        request: commit,
      }),
    );

    if (!answered.ok) {
      throw new Error(
        `the build output must arrive as a module map: ${JSON.stringify(answered).slice(0, 200)}`,
      );
    }

    expect(
      answered.moduleMap.length,
      "the module map exceeds the 64 KiB command output limit",
    ).toBeGreaterThan(OUTPUT_LIMIT_BYTES);
    expect(answered.moduleMap).toBe(oversizedModuleMap);
  });
});
