/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, expect, expectTypeOf, test } from "vitest";
import type { Supervisor } from "../../src/supervisor/supervisor.js";
import { artifact } from "./helpers.js";

// The Worker Loader caches by harness commit, so a second source under a reused commit is ignored.
const deadlineCommit = "cafe456789abcdef0123456789abcdef01234567";

function supervisor(name: string): DurableObjectStub<Supervisor> {
  return env.SUPERVISOR.getByName(name);
}

afterEach(async () => {
  await reset();
});

test("the Supervisor stub type offers controlGeneration and no raw generation mutation RPC", () => {
  const control = supervisor("control-generation-rpc-type");
  expectTypeOf(control).not.toHaveProperty("labelGeneration");
  expectTypeOf(control).not.toHaveProperty("recordPreparationCheck");
  expectTypeOf(control).not.toHaveProperty("activateGeneration");
  expectTypeOf(control).toHaveProperty("controlGeneration");
});

test("startup checking returns plain RPC values", async () => {
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

test("the failure arms of startup checking return plain RPC values", async () => {
  const control = supervisor("plain-startup-check-failures");
  const otherCommit = "cafe456789abcdef0123456789abcdef01234568";

  const submission = await control.controlGeneration({
    principal: { kind: "user" },
    command: { kind: "submit-candidate", harnessCommit: deadlineCommit },
  });

  if (!submission.ok) {
    throw new Error("a valid candidate submission must succeed");
  }

  const label = submission.outcome.generation.label;

  const failures = [
    await control.prepareGeneration(999),
    await control.checkGenerationStartup(label, artifact(otherCommit, "export {};")),
    await control.checkGenerationStartup(label, {
      harnessCommit: deadlineCommit,
      entryModule: "missing.js",
      modules: [{ name: "main.js", source: "" }],
    }),
  ];

  expect(failures).toStrictEqual([
    { ok: false, problem: { code: "unknown-generation", label: 999 } },
    {
      ok: false,
      problem: {
        code: "artifact-harness-commit-mismatch",
        label,
        generationHarnessCommit: deadlineCommit,
        artifactHarnessCommit: otherCommit,
      },
    },
    { ok: false, problem: { code: "entry-module-not-found", entryModule: "missing.js" } },
  ]);
  // A structured clone of a class instance is a plain object, so a value strictly equal to its own
  // clone holds plain objects only: no Result, no error class, no prototype.
  expect(failures).toStrictEqual(structuredClone(failures));
});

test("the failure arms of control, threads, and relay return plain values", async () => {
  const control = supervisor("plain-control-failures");

  const failures = [
    await control.controlGeneration({
      principal: { kind: "user" },
      command: { kind: "activate", label: 0, observedEpoch: 1 },
    }),
    await control.getProjectThread("not-a-project"),
  ];

  expect(failures).toStrictEqual([
    { ok: false, problem: { code: "stale-epoch" } },
    { ok: false, problem: { code: "unknown-project-id" } },
  ]);
  expect(failures).toStrictEqual(structuredClone(failures));

  const relayed = await control.fetch("https://supervisor.invalid/");

  expect(relayed.status).toBe(503);
  expect(await relayed.json()).toStrictEqual({
    ok: false,
    problem: { code: "no-active-generation" },
  });
});
