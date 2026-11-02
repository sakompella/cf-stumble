import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import type { Supervisor } from "../../src/supervisor/supervisor.js";
import { generationLabel, testHarnessCommit } from "./helpers.js";

function supervisor(name: string): DurableObjectStub<Supervisor> {
  return env.SUPERVISOR.getByName(name);
}

afterEach(async () => {
  await reset();
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
