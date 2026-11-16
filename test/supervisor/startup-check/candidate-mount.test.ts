import * as Effect from "effect/Effect";
import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, test, vi } from "vitest";
import { supervisorParts } from "../../../src/supervisor/supervisor-parts.js";
import { runStartupCheck } from "../../../src/supervisor/startup-check/candidate.js";
import { textLines } from "../../log-capture.js";
import {
  activeSupervisor,
  artifact,
  commits,
  parsedArtifact,
  servingFacetSource,
} from "../helpers.js";

afterEach(async () => {
  await reset();
});

test("logs the cause when the candidate facet cannot mount", async () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const control = await activeSupervisor("startup-check-mount-throws");

  const outcome = await runInDurableObject(control, (instance, state) => {
    vi.spyOn(state.facets, "get").mockImplementation(() => {
      throw new Error("the loader refused the module");
    });

    const parts = supervisorParts(state, env, () => false, {
      getActiveGeneration: () => instance.getActiveGeneration(),
      submitGeneration: (harnessCommit) => instance.submitGeneration(harnessCommit),
      prepareGeneration: (label) => instance.prepareGeneration(label),
      controlGeneration: (command) => instance.controlGeneration(command),
    });

    return Effect.runPromise(
      runStartupCheck(
        parts.startupCheckHost,
        parsedArtifact(artifact(commits.ordinary, servingFacetSource("ordinary"))),
        { compatibilityMs: 5_000, conversationMs: 90_000 },
      ),
    );
  });

  expect(outcome).toMatchObject({ stage: "mount-failed" });
  expect(textLines(errors)).toEqual([
    expect.stringContaining("the candidate facet could not mount: the loader refused the module"),
  ]);
});
