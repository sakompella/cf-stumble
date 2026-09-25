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
