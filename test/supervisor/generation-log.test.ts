/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, expect, test, vi } from "vitest";
import { namespaceFor } from "../workspace-namespace-fixture.js";
import { testHarnessCommit } from "../harness-commit-fixtures.js";
import { capturedEvents, named } from "../log-capture.js";
import {
  activateFixtureGeneration,
  activateGeneration,
  commits,
  prepareGeneration,
  submitCandidate,
} from "./helpers.js";
import {
  WorkspaceHostModuleMapBuilder,
  type BuildWorkspaceHost,
} from "../../src/supervisor/artifacts/index.js";
import type { HarnessBuildRequest } from "../../src/harness-build.js";
import type { WorkspaceResult } from "../../src/workspace/index.js";

/**
 * Generation control has to be diagnosable from Workers Logs alone: which commit a submission
 * labeled, how long each build step took and how it ended, what the preparation check decided,
 * and what an activation or a rollback did to the epoch.
 */

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

test("submission, activation, and rollback each log the label, the commit, and the epoch change", async () => {
  const events = capturedEvents();
  const control = env.SUPERVISOR.getByName("generation-log-control");
  await activateFixtureGeneration(control);
  const label = await submitCandidate(control, commits.ordinary);
  await prepareGeneration(control, label, commits.ordinary);
  const secondEpoch = await activateGeneration(control, label);

  const rolledBack = await control.controlGeneration({
    principal: { kind: "user" },
    command: { kind: "rollback", label: 0, observedEpoch: secondEpoch },
  });

  expect(rolledBack.ok).toBe(true);
  const controls = named(events(), "generation.control");
  expect(controls).toContainEqual(
    expect.objectContaining({
      command: "submit-candidate",
      principal: "user",
      label,
      commit: commits.ordinary.slice(0, 12),
      outcome: "candidate-submitted",
    }),
  );
  expect(controls).toContainEqual(
    expect.objectContaining({
      level: "info",
      command: "activate",
      label,
      // Preparing the candidate moved the epoch too, so the one before is whatever it last was.
      epochBefore: secondEpoch - 1,
      epochAfter: secondEpoch,
      outcome: "activated",
      effect: "activated",
    }),
  );
  expect(controls.at(-1)).toMatchObject({
    command: "rollback",
    label: 0,
    epochBefore: secondEpoch,
    epochAfter: secondEpoch + 1,
    outcome: "rolled-back",
  });
});

test("a rejected control request logs its problem code as degraded", async () => {
  const events = capturedEvents();
  const control = env.SUPERVISOR.getByName("generation-log-stale");
  const epoch = await activateFixtureGeneration(control);

  await control.controlGeneration({
    principal: { kind: "user" },
    command: { kind: "activate", label: 0, observedEpoch: epoch + 5 },
  });

  expect(named(events(), "generation.control").at(-1)).toMatchObject({
    level: "warn",
    command: "activate",
    label: 0,
    epochBefore: epoch,
    epochAfter: epoch,
    outcome: "stale-epoch",
  });
});

test("a preparation check logs its label, its outcome, and how long it took", async () => {
  const events = capturedEvents();
  const control = env.SUPERVISOR.getByName("generation-log-preparation");
  const label = await submitCandidate(control, commits.ordinary);
  await prepareGeneration(control, label, commits.ordinary);

  const [prepared] = named(events(), "generation.preparation");
  expect(prepared).toMatchObject({ level: "info", label, source: "submitted", outcome: "ready" });
  expect(prepared?.durationMs).toBeGreaterThanOrEqual(0);
});

/** Answers every build step, and exits `failingExit` on the one step it names. */
class StepHost implements BuildWorkspaceHost {
  private readonly failing: string | undefined;

  constructor(failing?: string) {
    this.failing = failing;
  }

  build(request: HarnessBuildRequest): Promise<WorkspaceResult> {
    const failed = request.kind === "build-step" && request.step === this.failing;

    return Promise.resolve({
      ok: true,
      result: { kind: "command", stdout: "{}", stderr: "", exitCode: failed ? 7 : 0 },
    });
  }
}

test("each build step logs its name, duration, and outcome, and stops at the one that failed", async () => {
  const events = capturedEvents();
  const commit = testHarnessCommit("6000000000000000000000000000000000000005");

  await new WorkspaceHostModuleMapBuilder(
    namespaceFor(new StepHost("checkout")),
    "generation-log-build-workspace",
  ).build(commit);

  const steps = named(events(), "harness-build.step");
  expect(steps.map((step) => [step.step, step.outcome])).toEqual([
    ["provision", "ok"],
    ["isolate", "ok"],
    ["checkout", "build-step-failed"],
  ]);
  expect(steps.at(-1)).toMatchObject({ level: "warn", exitCode: 7, commit: commit.slice(0, 12) });
  expect(steps.every((step) => Number(step.durationMs) >= 0)).toBe(true);
});
