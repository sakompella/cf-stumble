import type { MainFacetCapabilities } from "../../facet/index.js";
import type { StartupCheckOutcome } from "./body.js";

import { parseGenerationLabel } from "../generations/index.js";
import { timed, type TimedOutcome } from "../../diagnostics.js";
import type { HarnessArtifacts } from "../artifacts/index.js";
import { runStartupCheck } from "./candidate.js";
import { startupModuleMap } from "./module-map.js";
import type { StartupModuleMapProblem, StartupModuleMapSource } from "./module-map.js";

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
const STARTUP_CHECK_DEADLINE_MS = 5_000;

const STARTUP_CHECK_MAX_BODY_BYTES = 1_024;

/** What a startup check reads, records and mounts through. The Supervisor builds it once. */
export type StartupCheckHost = Readonly<{
  ctx: DurableObjectState;
  loader: WorkerLoader;
  artifacts: HarnessArtifacts;
  generations: Generations;
  modelRoute: () => MainFacetCapabilities["MODEL"];
}>;

export type StartupCheckOptions = {
  readonly deadlineMs?: number;
  readonly maxBodyBytes?: number;
};

type StartupCheckReport = StartupCheckOutcome & {
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

/**
 * Check a labeled generation's module map from `source` and record the outcome against the
 * generation. The check is logged by label and source, with how long it took and the stage it
 * reached.
 */
export function checkGenerationStartup(
  host: StartupCheckHost,
  label: number,
  source: StartupModuleMapSource,
  options: StartupCheckOptions = {},
): Promise<StartupCheckResult> {
  return timed(
    "generation.preparation",
    { label, source: source.kind },
    () => checkLabeledStartup(host, label, source, options),
    preparationOutcome,
  );
}

/** The stage the check reached, never its reason text: that is whatever the harness threw. */
function preparationOutcome(result: StartupCheckResult): TimedOutcome {
  if (!result.ok) return { outcome: result.problem.code, level: "warn" };

  return {
    outcome: result.report.stage,
    level: result.report.stage === "ready" ? "info" : "warn",
    fields: { effect: result.report.effect },
  };
}

/**
 * A module map that cannot be obtained records no preparation check. A missing build workspace or
 * a store that refused the write is not evidence about the candidate, and the active generation
 * keeps serving.
 */
async function checkLabeledStartup(
  host: StartupCheckHost,
  label: number,
  source: StartupModuleMapSource,
  options: StartupCheckOptions,
): Promise<StartupCheckResult> {
  const generationLabel = parseGenerationLabel(label);

  const generation =
    generationLabel === undefined ? undefined : host.generations.byLabel(generationLabel);

  if (generationLabel === undefined || generation === undefined) {
    return { ok: false, problem: { code: "unknown-generation", label } };
  }

  const moduleMap = await startupModuleMap(host.artifacts, generation, generationLabel, source);

  if (moduleMap.isErr()) {
    return { ok: false, problem: moduleMap.error };
  }

  const outcome = await runStartupCheck(host, moduleMap.value, generation.harnessCommit, {
    deadlineMs: options.deadlineMs ?? STARTUP_CHECK_DEADLINE_MS,
    maxBodyBytes: options.maxBodyBytes ?? STARTUP_CHECK_MAX_BODY_BYTES,
  });

  const recorded = host.generations.recordPreparationCheck(
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
