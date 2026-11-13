import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  releaseGeneration,
  RUN_ACTIVE_POLL_MS,
  type ActivationAnswer,
  type ReleaseDeps,
} from "./release.mts";

const ACTIVE = "a".repeat(40);

const MAIN = "b".repeat(40);

type Fake = Readonly<{ deps: ReleaseDeps; submitted: string[]; activations: number[] }>;

function fake(answers: readonly ActivationAnswer[], changed = true, ready = true): Fake {
  const submitted: string[] = [];
  const activations: number[] = [];
  let clock = 0;
  let epoch = 4;

  return {
    submitted,
    activations,
    deps: {
      owner: {
        active: () => Promise.resolve({ harnessCommit: ACTIVE, epoch }),
        submit: (harnessCommit) => {
          submitted.push(harnessCommit);

          return Promise.resolve({ label: 7, ready, reason: "conversation-failed: no answer" });
        },
        activate: (_label, observedEpoch) => {
          activations.push(observedEpoch);
          epoch += 1;

          return Promise.resolve(answers[activations.length - 1] ?? { ok: true, code: undefined });
        },
      },
      facetChangedSince: () => Promise.resolve(changed),
      wait: (ms) => {
        clock += ms;

        return Promise.resolve();
      },
      now: () => clock,
    },
  };
}

describe("release of main's commit as a generation", () => {
  it("submits and activates with the epoch it observed", async () => {
    const { deps, submitted, activations } = fake([]);

    assert.match(await releaseGeneration(MAIN, deps), /Activated generation 7/u);
    assert.deepEqual(submitted, [MAIN]);
    assert.deepEqual(activations, [4]);
  });

  it("skips when nothing the facet bundles changed", async () => {
    const { deps, submitted } = fake([], false);

    assert.match(await releaseGeneration(MAIN, deps), /^Skipped/u);
    assert.deepEqual(submitted, []);
  });

  it("retries while a run is active, re-reading the epoch", async () => {
    const busy = { ok: false, code: "run-active" };
    const { deps, activations } = fake([busy, busy]);

    assert.match(await releaseGeneration(MAIN, deps), /Activated/u);
    assert.deepEqual(activations, [4, 5, 6]);
  });

  it("reports, without failing, when a run stays active past the retry window", async () => {
    const answers = Array.from({ length: 100 }, () => ({ ok: false, code: "run-active" }));
    const { deps, activations } = fake(answers);

    assert.match(await releaseGeneration(MAIN, deps), /a run stayed active/u);
    assert.equal(activations.length, (15 * 60_000) / RUN_ACTIVE_POLL_MS + 1);
  });

  it("reports when main does not contain the active generation's commit", async () => {
    const { deps } = fake([{ ok: false, code: "drops-active-commit" }]);

    assert.match(await releaseGeneration(MAIN, deps), /does not contain/u);
  });

  it("fails when the startup check is not ready", async () => {
    const { deps, activations } = fake([], true, false);

    await assert.rejects(releaseGeneration(MAIN, deps), /not ready: conversation-failed/u);
    assert.deepEqual(activations, []);
  });
});
