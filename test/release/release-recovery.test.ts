import { expect, test } from "vitest";
import { PREPARE_DEADLINE_MS } from "../../tools/release-generation/release.mts";
import { ATTEMPT_MS, ProvisionHost, release } from "./recovering-release.js";

test("a release recovers when the Workspace Host's first provision rejects with an unmarked storage-startup error (deploy 44185631101)", async () => {
  const host = new ProvisionHost(2);
  const run = release(host);

  await expect(run.summary).resolves.toMatch(/^Activated generation \d+ for b+\.$/u);

  expect(run.labels.size, "every attempt prepares the one label of the commit").toBe(1);
  expect(host.provisions).toBe(3);
  expect(run.waits).toEqual([5_000, 10_000]);
  expect(run.events, "activation follows the ready preparation, once").toEqual([
    "prepare",
    "prepare",
    "prepare",
    "ready",
    "activate",
  ]);
});

test("a release repeats a submit that the platform rejected after its label was recorded", async () => {
  const run = release(new ProvisionHost(0), 1);

  await expect(run.summary).resolves.toMatch(/^Activated generation/u);

  expect(run.labels.size).toBe(1);
  expect(run.events).toEqual(["prepare", "ready", "activate"]);
  expect(run.waits).toEqual([5_000]);
});

test("a release does not repeat a build step that failed, and does not activate", async () => {
  const host = new ProvisionHost(0);
  host.answers = { install: { stdout: "", stderr: "ERR_PNPM_LOCKFILE", exitCode: 1 } };
  const run = release(host);

  await expect(run.summary).rejects.toThrow(/not ready: build-step-failed/u);

  expect(host.provisions).toBe(1);
  expect(run.waits).toEqual([]);
  expect(run.events).toEqual(["prepare"]);
});

test("a release that the infrastructure keeps interrupting ends at its one deadline with an infrastructure error", async () => {
  const run = release(new ProvisionHost(Number.POSITIVE_INFINITY));

  await expect(run.summary).rejects.toThrow(
    /infrastructure interrupted the preparation of b+ on all \d+ attempts within 10 minutes/u,
  );

  expect(run.clock()).toBeLessThanOrEqual(PREPARE_DEADLINE_MS + ATTEMPT_MS);
  expect(run.waits.every((wait) => wait <= 60_000)).toBe(true);
  expect(run.events).not.toContain("activate");
  expect(run.labels.size).toBe(1);
});
