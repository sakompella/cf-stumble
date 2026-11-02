import { env } from "cloudflare:workers";
import { evictDurableObject, reset } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import type { Supervisor } from "../../../src/supervisor/supervisor.js";
import { testHarnessCommit } from "../helpers.js";
import { readGenerations } from "../generation-reads.js";

const thirdCommit = "2123456789abcdef0123456789abcdef01234567";

function supervisor(name: string): DurableObjectStub<Supervisor> {
  return env.SUPERVISOR.getByName(name);
}

afterEach(async () => {
  await reset();
});

test("resubmitting the same harness commit still returns the existing generation after Durable Object eviction", async () => {
  const control = supervisor("control-resubmit-after-eviction");

  const first = await control.submitGeneration(testHarnessCommit(thirdCommit));
  await evictDurableObject(control);
  const resubmitted = await control.submitGeneration(testHarnessCommit(thirdCommit));

  expect(resubmitted).toEqual(first);
  expect(
    await readGenerations(control),
    "the generation table, not a request journal, is what survives eviction",
  ).toHaveLength(1);
});
