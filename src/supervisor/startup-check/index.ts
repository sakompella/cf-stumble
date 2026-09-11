import type { MainFacetCapabilities, MainHarnessArtifactInput } from "../../facet/index.js";
import type { StartupCheckOutcome } from "./body.js";

export type { StartupCheckOutcome, StartupCheckStage } from "./body.js";

import { parseGenerationLabel } from "../generations/index.js";
import type { GenerationLabel } from "../generations/index.js";
import type { HarnessArtifacts } from "../artifacts/index.js";
import { runStartupCheck } from "./candidate.js";
import { startupModuleMap } from "./module-map.js";
import type { StartupModuleMapProblem, StartupModuleMapSource } from "./module-map.js";

export type { StartupModuleMapSource } from "./module-map.js";

import type {
  Generation,
  Generations,
  PreparationCheckProblem,
  PreparationCheckResult,
} from "../generations/index.js";

/**
 * A generous bound, because the check has to cover a Dynamic Worker load and a cold Durable
 * Object start. Nothing local can measure what production needs, so tests pass their own.
 */
export const STARTUP_CHECK_DEADLINE_MS = 5_000;

export const STARTUP_CHECK_MAX_BODY_BYTES = 1_024;

export type StartupCheckOptions = {
  readonly deadlineMs?: number;
  readonly maxBodyBytes?: number;
};

export type StartupCheckReport = StartupCheckOutcome & {
  readonly generation: Generation;
  readonly effect: "recorded" | "no-op";
};

export type StartupCheckResult =
  | { readonly ok: true; readonly report: StartupCheckReport }
  | {
      readonly ok: false;
      readonly problem:
        | { readonly code: "unknown-generation"; readonly label: number }
        | StartupModuleMapProblem
        | PreparationCheckProblem;
    };

/** Check a module map the caller already holds against its labeled generation. */
export function checkGenerationStartup(
  ctx: DurableObjectState,
  loader: WorkerLoader,
  artifacts: HarnessArtifacts,
  generations: Generations,
  label: number,
  input: MainHarnessArtifactInput,
  modelRoute: MainFacetCapabilities["MODEL"],
  options: StartupCheckOptions = {},
): Promise<StartupCheckResult> {
  return checkGenerationStartupFrom(
    ctx,
    loader,
    artifacts,
    generations,
    label,
    { kind: "submitted", input },
    modelRoute,
    options,
  );
}

/**
 * Check a labeled generation from its harness commit alone. The module map comes from the
 * Supervisor's store, or from a build of that commit which is stored before the check runs, so a
 * generation that this reports as ready has its code stored.
 */
export function prepareGenerationStartup(
  ctx: DurableObjectState,
  loader: WorkerLoader,
  artifacts: HarnessArtifacts,
  generations: Generations,
  label: number,
  modelRoute: MainFacetCapabilities["MODEL"],
  options: StartupCheckOptions = {},
): Promise<StartupCheckResult> {
  return checkGenerationStartupFrom(
    ctx,
    loader,
    artifacts,
    generations,
    label,
    { kind: "prepared" },
    modelRoute,
    options,
  );
}

function checkGenerationStartupFrom(
  ctx: DurableObjectState,
  loader: WorkerLoader,
  artifacts: HarnessArtifacts,
  generations: Generations,
  label: number,
  source: StartupModuleMapSource,
  modelRoute: MainFacetCapabilities["MODEL"],
  options: StartupCheckOptions,
): Promise<StartupCheckResult> {
  const generationLabel = parseGenerationLabel(label);

  if (generationLabel === undefined) {
    return Promise.resolve({ ok: false, problem: { code: "unknown-generation", label } });
  }

  const generation = generations.byLabel(generationLabel);

  if (generation === undefined) {
    return Promise.resolve({ ok: false, problem: { code: "unknown-generation", label } });
  }

  return checkKnownGenerationStartup(
    ctx,
    loader,
    artifacts,
    generations,
    generationLabel,
    generation,
    source,
    modelRoute,
    options,
  );
}

/**
 * A module map that cannot be obtained records no preparation check. A missing build workspace or
 * a store that refused the write is not evidence about the candidate, and the active generation
 * keeps serving.
 */
async function checkKnownGenerationStartup(
  ctx: DurableObjectState,
  loader: WorkerLoader,
  artifacts: HarnessArtifacts,
  generations: Generations,
  generationLabel: GenerationLabel,
  generation: Generation,
  source: StartupModuleMapSource,
  modelRoute: MainFacetCapabilities["MODEL"],
  options: StartupCheckOptions,
): Promise<StartupCheckResult> {
  const moduleMap = await startupModuleMap(artifacts, generation, generationLabel, source);

  if (moduleMap.isErr()) {
    return { ok: false, problem: moduleMap.error };
  }

  const outcome = await runStartupCheck(
    ctx,
    loader,
    moduleMap.value,
    generation.harnessCommit,
    modelRoute,
    {
      deadlineMs: options.deadlineMs ?? STARTUP_CHECK_DEADLINE_MS,
      maxBodyBytes: options.maxBodyBytes ?? STARTUP_CHECK_MAX_BODY_BYTES,
    },
  );

  const recorded = generations.recordPreparationCheck(
    generationLabel,
    outcome.stage === "ready" ? "passed" : "failed",
  );

  return startupCheckResult(outcome, recorded);
}

function startupCheckResult(
  outcome: StartupCheckOutcome,
  recorded: PreparationCheckResult,
): StartupCheckResult {
  if (recorded.isErr()) {
    return { ok: false, problem: recorded.error };
  }

  return {
    ok: true,
    report: {
      ...outcome,
      generation: recorded.value.generation,
      effect: recorded.value.effect,
    },
  };
}
