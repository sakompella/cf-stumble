import { env } from "cloudflare:workers";
import { evictDurableObject, reset } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import type { Supervisor } from "../../src/supervisor/supervisor.js";
import {
  activateGeneration,
  activeSupervisor,
  artifact,
  prepareWithModuleMap,
  servedText,
  servingFacetSource,
  submitCandidate,
  generationLabel,
} from "./helpers.js";
import { readGenerations } from "./generation-reads.js";

function supervisor(name: string): DurableObjectStub<Supervisor> {
  return env.SUPERVISOR.getByName(name);
}

function servingArtifact(harnessCommit: string) {
  return artifact(harnessCommit, servingFacetSource("candidate serving body"));
}

function failingArtifact(harnessCommit: string) {
  return artifact(
    harnessCommit,
    servingFacetSource("candidate failed", `compatibility() { return "0.0.1"; }`),
  );
}

async function activateServingCandidate(
  control: DurableObjectStub<Supervisor>,
  harnessCommit: string,
): Promise<void> {
  const candidate = await submitCandidate(control, harnessCommit);
  const startup = await prepareWithModuleMap(control, candidate, servingArtifact(harnessCommit));

  if (!startup.ok || startup.report.stage !== "ready") {
    throw new Error("the candidate must pass startup before activation");
  }

  await activateGeneration(control, candidate);
}

afterEach(async () => {
  await reset();
});

test("reports a typed failure and serves nothing when no generation is active", async () => {
  const control = supervisor("no-active-generation-serves-nothing");

  expect(await servedText(control)).toBe("refused: no-active-generation");
  expect(await readGenerations(control), "no submission means no labeled generation").toEqual([]);
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
