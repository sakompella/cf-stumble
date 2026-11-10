import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import * as Effect from "effect/Effect";
import { afterEach, expect, test } from "vitest";
import { loadMainFacet, FACET_COMPATIBILITY } from "../../../src/facet/index.js";
import { candidateFacetName } from "../../../src/supervisor/artifacts/facet-name.js";
import { runStartupCheck } from "../../../src/supervisor/startup-check/candidate.js";
import { supervisorParts } from "../../../src/supervisor/supervisor-parts.js";
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

test.each(["ready", "compatibility-mismatch", "deadline-expired"] as const)(
  "a startup check that ends with %s deletes its candidate storage",
  async (stage) => {
    const control = await activeSupervisor(`startup-check-cleanup-${stage}`);

    const candidate = parsedArtifact(
      artifact(
        stage === "ready"
          ? commits.fresh
          : stage === "compatibility-mismatch"
            ? commits.noVersion
            : commits.delayed,
        servingFacetSource(
          "candidate",
          `async compatibility() {
    this.ctx.storage.kv.put("checked", true);
    ${stage === "deadline-expired" ? "return new Promise(() => {});" : `return ${JSON.stringify(stage === "ready" ? FACET_COMPATIBILITY : "incompatible")};`}
  }
  fetch() {
    return new Response(this.ctx.storage.kv.get("checked") ? "retained" : "empty");
  }`,
        ),
      ),
    );

    await runInDurableObject(control, async (instance, state) => {
      const { startupCheckHost: host } = supervisorParts(state, env, () => false, {
        getActiveGeneration: () => instance.getActiveGeneration(),
        submitGeneration: (commit) => instance.submitGeneration(commit),
        prepareGeneration: (label) => instance.prepareGeneration(label),
        controlGeneration: (command) => instance.controlGeneration(command),
      });

      const outcome = await Effect.runPromise(
        runStartupCheck(host, candidate, { compatibilityMs: 500, conversationMs: 5_000 }),
      );

      expect(outcome.stage).toBe(stage);

      const name = candidateFacetName(candidate.harnessCommit);
      state.facets.abort(name, "inspect candidate storage after the check");
      const { facetClass } = loadMainFacet(env.LOADER, candidate, { MODEL: host.model() }, name);
      const probe = state.facets.get(name, () => ({ class: facetClass }));

      try {
        expect(await (await probe.fetch("https://candidate.test/")).text()).toBe("empty");
      } finally {
        state.facets.delete(name);
      }
    });
  },
);
