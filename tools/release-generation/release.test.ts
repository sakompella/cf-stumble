import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { releaseGeneration, type ActivationAnswer, type ReleaseDeps } from "./release.mts";

const ACTIVE = "a".repeat(40);

const MAIN = "b".repeat(40);

type Fake = Readonly<{
  deps: ReleaseDeps;
  submitted: string[];
  activations: number[];
  activatedAtMs: number[];
  forced: boolean[];
}>;

function fake(answers: readonly ActivationAnswer[], changed = true, ready = true): Fake {
  const submitted: string[] = [];
  const activations: number[] = [];
  const activatedAtMs: number[] = [];
  const forced: boolean[] = [];
  let clock = 0;
  let epoch = 4;

  return {
    submitted,
    activations,
    activatedAtMs,
    forced,
    deps: {
      owner: {
        active: () => Promise.resolve({ harnessCommit: ACTIVE, epoch }),
        submit: (harnessCommit) => {
          submitted.push(harnessCommit);

          return Promise.resolve({ label: 7, ready, reason: "conversation-failed: no answer" });
        },
        activate: (_label, observedEpoch, force) => {
          activations.push(observedEpoch);
          activatedAtMs.push(clock);
          forced.push(force);
          epoch += 1;

          return Promise.resolve(answers[activations.length - 1] ?? { ok: true, code: undefined });
        },
      },
      force: false,
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

  it("submits nothing when main's commit is already the active generation", async () => {
    const { deps, submitted } = fake([]);

    assert.match(await releaseGeneration(ACTIVE, deps), /already the active generation/u);
    assert.deepEqual(submitted, []);
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

  it("keeps retrying a busy run for fifteen minutes, then reports without failing", async () => {
    const answers = Array.from({ length: 100 }, () => ({ ok: false, code: "run-active" }));
    const { deps, activatedAtMs } = fake(answers);

    assert.match(await releaseGeneration(MAIN, deps), /a run stayed active for 15 minutes/u);
    assert.equal(activatedAtMs.at(-1), 15 * 60_000);
    assert.ok((activatedAtMs.at(-2) ?? Infinity) < 15 * 60_000);
  });

  it("activates again at once with the new epoch when the observed one went stale", async () => {
    const { deps, activations, activatedAtMs } = fake([{ ok: false, code: "stale-epoch" }]);

    assert.match(await releaseGeneration(MAIN, deps), /Activated/u);
    assert.deepEqual(activations, [4, 5]);
    assert.deepEqual(activatedAtMs, [0, 0]);
  });

  it("fails on an activation answer it does not know", async () => {
    const { deps } = fake([{ ok: false, code: "unknown-generation" }]);

    await assert.rejects(releaseGeneration(MAIN, deps), /answered unknown-generation/u);
  });
});

describe("activation answers other than success", () => {
  it("reports when main does not contain the active generation's commit", async () => {
    const { deps } = fake([{ ok: false, code: "drops-active-commit" }]);

    assert.match(await releaseGeneration(MAIN, deps), /does not contain/u);
  });

  it("sends force when asked, so a preview can replace another branch's generation", async () => {
    const { deps, forced } = fake([]);

    assert.match(await releaseGeneration(MAIN, { ...deps, force: true }), /Activated/u);
    assert.deepEqual(forced, [true]);
  });

  it("fails when the startup check is not ready", async () => {
    const { deps, activations } = fake([], true, false);

    await assert.rejects(releaseGeneration(MAIN, deps), /not ready: conversation-failed/u);
    assert.deepEqual(activations, []);
  });
});
