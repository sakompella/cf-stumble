/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, expect, expectTypeOf, test } from "vitest";
import type { Supervisor } from "../../src/supervisor/supervisor.js";
import { artifact, readyArtifact } from "./helpers.js";

const harnessCommit = "0123456789abcdef0123456789abcdef01234567";

// The Worker Loader caches by harness commit, so a second source under a reused commit is ignored.
const deadlineCommit = "cafe456789abcdef0123456789abcdef01234567";

function supervisor(name: string): DurableObjectStub<Supervisor> {
  return env.SUPERVISOR.getByName(name);
}

function candidateSubmission() {
  return {
    principal: { kind: "user" } as const,
    command: { kind: "submit-candidate" as const, harnessCommit },
  };
}

/** Label and pass startup checking for `harnessCommit`, returning its generation label. */
async function readyCandidateLabel(control: DurableObjectStub<Supervisor>): Promise<number> {
  const submission = await control.controlGeneration(candidateSubmission());

  if (!submission.ok) {
    throw new Error("a valid candidate submission must succeed");
  }

  const startup = await control.checkGenerationStartup(
    submission.outcome.generation.label,
    readyArtifact(harnessCommit),
  );

  if (!startup.ok) {
    throw new Error("a valid candidate must complete startup checking");
  }

  return submission.outcome.generation.label;
}

afterEach(async () => {
  await reset();
});

test("the real stub exposes only controlGeneration for generation mutation", async () => {
  const control = supervisor("control-only-generation-mutation");
  expectTypeOf(control).not.toHaveProperty("labelGeneration");
  expectTypeOf(control).not.toHaveProperty("recordPreparationCheck");
  expectTypeOf(control).not.toHaveProperty("activateGeneration");
  expectTypeOf(control).toHaveProperty("controlGeneration");

  const submission = candidateSubmission();
  const firstSubmission = await control.controlGeneration(submission);
  const resubmission = await control.controlGeneration(submission);

  expect(
    resubmission,
    "resubmitting an already-labeled commit returns the existing generation",
  ).toEqual(firstSubmission);
});

test("the real stub applies epoch-checked activation directly: stale epochs reject, the active label is a no-op", async () => {
  const control = supervisor("control-epoch-checked-activation");
  const label = await readyCandidateLabel(control);
  const active = await control.getActiveGeneration();

  const stale = await control.controlGeneration({
    principal: { kind: "user" },
    command: { kind: "activate", label, observedEpoch: active.epoch - 1 },
  });

  const firstActivation = await control.controlGeneration({
    principal: { kind: "user" },
    command: { kind: "activate", label, observedEpoch: active.epoch },
  });

  if (!firstActivation.ok) {
    throw new Error("a checked candidate must accept activation");
  }

  const noOpActivation = await control.controlGeneration({
    principal: { kind: "user" },
    command: { kind: "activate", label, observedEpoch: firstActivation.outcome.epoch },
  });

  expect(stale).toEqual({ ok: false, problem: { code: "stale-epoch" } });
  expect(firstActivation).toMatchObject({ ok: true, outcome: { kind: "activated" } });
  expect(noOpActivation, "activating the already-active generation is a no-op").toMatchObject({
    ok: true,
    outcome: { kind: "activated", effect: "no-op", epoch: firstActivation.outcome.epoch },
  });
});

test("startup checking maps TaggedErrors to plain RPC values", async () => {
  const control = supervisor("plain-startup-check-result");

  const submission = await control.controlGeneration({
    principal: { kind: "user" },
    command: { kind: "submit-candidate", harnessCommit: deadlineCommit },
  });

  if (!submission.ok || submission.outcome.kind !== "candidate-submitted") {
    throw new Error("a valid candidate submission must succeed");
  }

  const result = await control.checkGenerationStartup(
    submission.outcome.generation.label,
    artifact(
      deadlineCommit,
      `
import { DurableObject } from "cloudflare:workers";
export class MainFacet extends DurableObject {
  fetch() { return new Promise(() => {}); }
}
`,
    ),
    { deadlineMs: 50 },
  );

  expect(result).toMatchObject({
    ok: true,
    report: { stage: "deadline-expired", reason: "response headers exceeded the deadline" },
  });
  expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
  expect(result).not.toHaveProperty("status");
  expect(result).not.toHaveProperty("match");

  if (!result.ok) {
    throw new Error("a labeled generation must return a startup-check report");
  }

  expect(Object.getPrototypeOf(result.report)).toBe(Object.prototype);
  expect(result.report).not.toHaveProperty("_tag");
  expect(result.report).not.toHaveProperty("cause");
});
