import { env } from "cloudflare:workers";
import { evictDurableObject, reset } from "cloudflare:test";
import { afterEach, expect, test, vi } from "vitest";
import type { Supervisor } from "../../src/supervisor/supervisor.js";
import { eventuallyTruthy } from "../eventually.js";
import {
  activateGeneration,
  activeSupervisor,
  artifact,
  connectedSupervisor,
  prepareWithModuleMap,
  servedText,
  servingFacetSource,
  submitCandidate,
  generationLabel,
} from "./helpers.js";

function supervisor(name: string): DurableObjectStub<Supervisor> {
  return env.SUPERVISOR.getByName(name);
}

function servingArtifact(harnessCommit: string, body = "candidate serving body") {
  return artifact(harnessCommit, servingFacetSource(body));
}

function failingArtifact(harnessCommit: string) {
  return artifact(
    harnessCommit,
    servingFacetSource("candidate failed", `compatibility() { return "0.0.1"; }`),
  );
}

async function readyServingCandidate(
  control: DurableObjectStub<Supervisor>,
  harnessCommit: string,
  body?: string,
): Promise<number> {
  const candidate = await submitCandidate(control, harnessCommit);

  const startup = await prepareWithModuleMap(
    control,
    candidate,
    servingArtifact(harnessCommit, body),
  );

  if (!startup.ok || startup.report.stage !== "ready") {
    throw new Error("the candidate must pass startup before activation");
  }

  return candidate;
}

async function activateServingCandidate(
  control: DurableObjectStub<Supervisor>,
  harnessCommit: string,
): Promise<void> {
  await activateGeneration(control, await readyServingCandidate(control, harnessCommit));
}

function holdFirstModuleMapRead(commit: string) {
  const read = env.MODULE_MAPS.get.bind(env.MODULE_MAPS);
  const gate = { reading: false, release: (): void => {} };

  const held = new Promise<void>((resolve) => {
    gate.release = resolve;
  });

  vi.spyOn(env.MODULE_MAPS, "get").mockImplementation(async (key: string) => {
    if (key.includes(commit) && !gate.reading) {
      gate.reading = true;
      await held;
    }

    return read(key);
  });

  return gate;
}

afterEach(async () => {
  await reset();
});

test("reports a typed failure and serves nothing when no generation is active", async () => {
  const control = supervisor("no-active-generation-serves-nothing");

  expect(await servedText(control)).toBe("refused: no-active-generation");
  expect(await control.getActiveGeneration()).toMatchObject({ generation: undefined, epoch: 0 });
});

test("serves the active retained artifact after Durable Object eviction", async () => {
  const control = await activeSupervisor("serves-active-generation-after-eviction");
  await activateServingCandidate(control, "d123456789abcdef0123456789abcdef01234567");
  await evictDurableObject(control);

  expect(await servedText(control)).toBe("candidate serving body");
});

test("keeps the active retained artifact when a failed candidate cannot activate", async () => {
  const control = await activeSupervisor("failed-candidate-keeps-active-artifact");
  await activateServingCandidate(control, "e123456789abcdef0123456789abcdef01234567");

  const failedCandidate = await submitCandidate(
    control,
    "f123456789abcdef0123456789abcdef01234567",
  );

  const failedStartup = await prepareWithModuleMap(
    control,
    failedCandidate,
    failingArtifact("f123456789abcdef0123456789abcdef01234567"),
  );

  if (!failedStartup.ok || failedStartup.report.stage !== "compatibility-mismatch") {
    throw new Error("the candidate must fail its startup check");
  }

  const active = await control.getActiveGeneration();

  const activation = await control.controlGeneration({
    kind: "activate",
    label: generationLabel(failedCandidate),
    observedEpoch: active.epoch,
  });

  expect(activation).toEqual({ ok: false, problem: { code: "not-ready" } });
  expect(await servedText(control)).toBe("candidate serving body");
});

test("a rollback during the module map read of a cold mount serves the rolled-back generation", async () => {
  const first = "a0a0000000000000000000000000000000000001";
  const control = await connectedSupervisor("rollback-during-cold-mount");
  const labelA = await readyServingCandidate(control, first, "served by A");

  await activateGeneration(control, labelA);

  const labelB = await readyServingCandidate(
    control,
    "b0b0000000000000000000000000000000000002",
    "served by B",
  );

  await activateGeneration(control, labelB);
  await activateGeneration(control, labelA);
  await evictDurableObject(control);

  const read = holdFirstModuleMapRead(first);
  const { epoch } = await control.getActiveGeneration();
  const racing = servedText(control);

  await eventuallyTruthy(() => read.reading);

  const rollback = await control.controlGeneration({
    kind: "rollback",
    label: generationLabel(labelB),
    observedEpoch: epoch,
  });

  read.release();

  expect(rollback).toMatchObject({ ok: true, outcome: { effect: "activated" } });
  expect(await racing).toBe("served by B");
  expect(await servedText(control)).toBe("served by B");
});
