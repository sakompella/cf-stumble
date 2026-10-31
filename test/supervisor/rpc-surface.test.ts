import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, expect, expectTypeOf, test } from "vitest";
import type { Supervisor } from "../../src/supervisor/supervisor.js";
import {
  artifact,
  prepareWithModuleMap,
  servedText,
  generationLabel,
  testHarnessCommit,
} from "./helpers.js";

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
  expectTypeOf(control).not.toHaveProperty("recordPreparation");
  expectTypeOf(control).not.toHaveProperty("activateGeneration");
  expectTypeOf(control).not.toHaveProperty("checkGenerationStartup");
  expectTypeOf(control).toHaveProperty("controlGeneration");
});

test("startup checking returns plain RPC values", async () => {
  const control = supervisor("plain-startup-check-result");

  const submission = await control.submitGeneration(testHarnessCommit(deadlineCommit));

  const result = await prepareWithModuleMap(
    control,
    submission.generation.label,
    artifact(
      deadlineCommit,
      `
import { DurableObject } from "cloudflare:workers";
export class MainFacet extends DurableObject {
  piDurableVersion() { return new Promise(() => {}); }
}
`,
    ),
    { deadlineMs: 50 },
  );

  expect(result).toMatchObject({
    ok: true,
    report: { stage: "deadline-expired", reason: "the Pi Durable version exceeded the deadline" },
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
  const unstoredCommit = "cafe456789abcdef0123456789abcdef01234568";

  const submission = await control.submitGeneration(testHarnessCommit(unstoredCommit));

  const failures = [
    await control.prepareGeneration(generationLabel(999)),
    await control.prepareGeneration(submission.generation.label),
  ];

  expect(failures).toStrictEqual([
    { ok: false, problem: { code: "unknown-generation", label: 999 } },
    { ok: false, problem: { code: "build-workspace-unavailable", harnessCommit: unstoredCommit } },
  ]);
  expect(failures).toStrictEqual(structuredClone(failures));
});

test("the failure arms of control and conversations return plain values", async () => {
  const control = supervisor("plain-control-failures");

  const failures = [
    await control.controlGeneration({
      kind: "activate",
      label: generationLabel(0),
      observedEpoch: 1,
    }),
    await control.submitProjectMessage("not-a-project", "hello", "r1"),
  ];

  expect(failures).toStrictEqual([
    { ok: false, problem: { code: "stale-epoch" } },
    { ok: false, problem: { code: "unknown-project-id" } },
  ]);
  expect(failures).toStrictEqual(structuredClone(failures));
  expect(await servedText(control)).toBe("refused: no-active-generation");
});
