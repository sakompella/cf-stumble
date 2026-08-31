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
    requestId: "controlled-candidate",
    principal: { kind: "user" } as const,
    command: { kind: "submit-candidate" as const, harnessCommit },
  };
}

afterEach(async () => {
  await reset();
});

test("the real stub journals candidate submission and epoch-checked activation without unchecked mutation RPCs", async () => {
  const control = supervisor("control-only-generation-mutation");
  expectTypeOf(control).toHaveProperty("getRelayAttempts");
  expectTypeOf(control).not.toHaveProperty("getRelayFacts");
  expectTypeOf(control).not.toHaveProperty("labelGeneration");
  expectTypeOf(control).not.toHaveProperty("recordPreparationCheck");
  expectTypeOf(control).not.toHaveProperty("activateGeneration");
  expectTypeOf(control).toHaveProperty("controlGeneration");
  const submission = candidateSubmission();
  const firstSubmission = await control.controlGeneration(submission);
  const replayedSubmission = await control.controlGeneration(submission);
  if (!firstSubmission.ok) {
    throw new Error("a valid candidate submission must succeed");
  }

  const startup = await control.checkGenerationStartup(
    firstSubmission.outcome.generation.label,
    readyArtifact(harnessCommit),
  );
  if (!startup.ok) {
    throw new Error("a valid candidate must complete startup checking");
  }

  const active = await control.getActiveGeneration();
  const stale = await control.controlGeneration({
    requestId: "stale-controlled-activation",
    principal: { kind: "user" },
    command: {
      kind: "activate",
      label: firstSubmission.outcome.generation.label,
      observedEpoch: active.epoch - 1,
    },
  });
  const activation = {
    requestId: "controlled-activation",
    principal: { kind: "user" } as const,
    command: {
      kind: "activate" as const,
      label: firstSubmission.outcome.generation.label,
      observedEpoch: active.epoch,
    },
  };
  const firstActivation = await control.controlGeneration(activation);
  const replayedActivation = await control.controlGeneration(activation);

  expect(replayedSubmission).toEqual(firstSubmission);
  expect(stale).toEqual({ ok: false, problem: { code: "stale-epoch" } });
  expect(firstActivation).toMatchObject({ ok: true, outcome: { kind: "activated" } });
  expect(replayedActivation).toEqual(firstActivation);
});

test("startup checking maps TaggedErrors to plain RPC values", async () => {
  const control = supervisor("plain-startup-check-result");
  const submission = await control.controlGeneration({
    requestId: "deadline-candidate",
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
