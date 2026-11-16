import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { releaseGeneration, type ActivationAnswer, type ReleaseDeps } from "./release.mts";

const ACTIVE = "a".repeat(40);

const MAIN = "b".repeat(40);

type Fake = Readonly<{
  deps: ReleaseDeps;
  submitted: string[];
  activations: number[];
  activatedLabels: number[];
  activatedAtMs: number[];
  forced: boolean[];
}>;

function fake(
  answers: readonly ActivationAnswer[],
  changed = true,
  preparations: readonly string[] = [],
): Fake {
  const submitted: string[] = [];
  const activations: number[] = [];
  const activatedLabels: number[] = [];
  const activatedAtMs: number[] = [];
  const forced: boolean[] = [];
  let clock = 0;
  let epoch = 4;

  return {
    submitted,
    activations,
    activatedLabels,
    activatedAtMs,
    forced,
    deps: {
      owner: {
        active: () => Promise.resolve({ harnessCommit: ACTIVE, epoch }),
        submit: (harnessCommit) => {
          submitted.push(harnessCommit);

          const code = preparations[submitted.length - 1];

          return Promise.resolve({
            label: 6 + submitted.length,
            ready: code === undefined,
            reason: code ?? "ready",
            code,
          });
        },
        activate: (label, observedEpoch, force) => {
          activations.push(observedEpoch);
          activatedLabels.push(label);
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
    const { deps, activations } = fake([], true, ["conversation-failed"]);

    await assert.rejects(releaseGeneration(MAIN, deps), /not ready: conversation-failed/u);
    assert.deepEqual(activations, []);
  });

  it("prepares main's commit again when the platform restarted the workspace mid-build (deploy 43934982845)", async () => {
    const { deps, submitted, activatedLabels } = fake([], true, ["build-workspace-unavailable"]);

    assert.match(await releaseGeneration(MAIN, deps), /Activated generation 8/u);
    assert.deepEqual(submitted, [MAIN, MAIN]);
    assert.deepEqual(activatedLabels, [8]);
  });

  it("fails when the workspace is unavailable again on the second preparation", async () => {
    const unavailable = "build-workspace-unavailable";
    const { deps, submitted, activations } = fake([], true, [unavailable, unavailable]);

    await assert.rejects(
      releaseGeneration(MAIN, deps),
      /generation 8 .* not ready: build-workspace/u,
    );
    assert.equal(submitted.length, 2);
    assert.deepEqual(activations, []);
  });
});
