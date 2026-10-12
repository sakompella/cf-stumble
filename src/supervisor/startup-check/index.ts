import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import type { MainFacetCapabilities } from "../../facet/index.js";
import type { StartupCheckOutcome } from "./body.js";

import { parseGenerationLabel } from "../generations/index.js";
import { timedEffect, type TimedOutcome } from "../../diagnostics.js";
import type { HarnessArtifacts } from "../artifacts/index.js";
import { runStartupCheck } from "./candidate.js";
import { startupModuleMap } from "./module-map.js";
import type { StartupModuleMapProblem, StartupModuleMapSource } from "./module-map.js";

import type { Generation, Generations, PreparationCheckProblem } from "../generations/index.js";

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

type StartupCheckProblem =
  | { readonly code: "unknown-generation"; readonly label: number }
  | StartupModuleMapProblem
  | PreparationCheckProblem;

export type StartupCheckResult =
  | { readonly ok: true; readonly report: StartupCheckReport }
  | { readonly ok: false; readonly problem: StartupCheckProblem };

/**
 * Check a labeled generation's module map from `source` and record the outcome against the
 * generation. The check is logged by label and source, with how long it took and the stage it
 * reached. The Supervisor returns the plain union over RPC from checkGenerationStartup and
 * prepareGeneration (ADR-0045), so every expected failure is already a value here.
 */
export function checkGenerationStartup(
  host: StartupCheckHost,
  label: number,
  source: StartupModuleMapSource,
  options: StartupCheckOptions = {},
): Effect.Effect<StartupCheckResult> {
  return checkLabeledStartup(host, label, source, options).pipe(
    timedEffect("generation.preparation", { label, source: source.kind }, preparationOutcome),
    Effect.match({
      onSuccess: (report): StartupCheckResult => ({ ok: true, report }),
      onFailure: (problem): StartupCheckResult => ({ ok: false, problem }),
    }),
  );
}

/** The stage the check reached, never its reason text: that is whatever the harness threw. */
function preparationOutcome(
  result: Result.Result<StartupCheckReport, StartupCheckProblem>,
): TimedOutcome {
  if (Result.isFailure(result)) return { outcome: result.failure.code, level: "warn" };

  const report = result.success;

  return {
    outcome: report.stage,
    level: report.stage === "ready" ? "info" : "warn",
    fields: { effect: report.effect },
  };
}

/**
 * A module map that cannot be obtained records no preparation check. A missing build workspace or
 * a store that refused the write is not evidence about the candidate, and the active generation
 * keeps serving.
 */
function checkLabeledStartup(
  host: StartupCheckHost,
  label: number,
  source: StartupModuleMapSource,
  options: StartupCheckOptions,
): Effect.Effect<StartupCheckReport, StartupCheckProblem> {
  return Effect.gen(function* () {
    const generationLabel = parseGenerationLabel(label);

    const generation =
      generationLabel === undefined ? undefined : host.generations.byLabel(generationLabel);

    if (generationLabel === undefined || generation === undefined) {
      return yield* Effect.fail<StartupCheckProblem>({ code: "unknown-generation", label });
    }

    const moduleMap = yield* startupModuleMap(host.artifacts, generation, generationLabel, source);

    const outcome = yield* Effect.promise(() =>
      runStartupCheck(host, moduleMap, generation.harnessCommit, {
        deadlineMs: options.deadlineMs ?? STARTUP_CHECK_DEADLINE_MS,
        maxBodyBytes: options.maxBodyBytes ?? STARTUP_CHECK_MAX_BODY_BYTES,
      }),
    );

    const recorded = yield* Effect.fromResult(
      host.generations.recordPreparationCheck(
        generationLabel,
        outcome.stage === "ready" ? "passed" : "failed",
      ),
    );

    return { ...outcome, generation: recorded.generation, effect: recorded.effect };
  });
}
