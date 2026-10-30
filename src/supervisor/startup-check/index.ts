import * as Effect from "effect/Effect";
import type { MainFacetCapabilities } from "../../facet/index.js";
import type { StartupCheckOutcome } from "./body.js";

import { parseGenerationLabel } from "../generations/index.js";
import type { HarnessArtifacts, ModuleMapProblem } from "../artifacts/index.js";
import { runStartupCheck } from "./candidate.js";

import type { Generation, Generations, PreparationCheckProblem } from "../generations/index.js";

/** Covers a Dynamic Worker load and a cold Durable Object start. Tests pass their own. */
const STARTUP_CHECK_DEADLINE_MS = 5_000;

const STARTUP_CHECK_MAX_BODY_BYTES = 1_024;

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
  | ModuleMapProblem
  | PreparationCheckProblem;

export type StartupCheckResult =
  | { readonly ok: true; readonly report: StartupCheckReport }
  | { readonly ok: false; readonly problem: StartupCheckProblem };

export function checkGenerationStartup(
  host: StartupCheckHost,
  label: number,
  options: StartupCheckOptions = {},
): Effect.Effect<StartupCheckResult> {
  return checkLabeledStartup(host, label, options).pipe(
    Effect.match({
      onSuccess: (report): StartupCheckResult => ({ ok: true, report }),
      onFailure: (problem): StartupCheckResult => ({ ok: false, problem }),
    }),
  );
}

/** A map that cannot be obtained records no check: that is no evidence about the candidate, and the active generation keeps serving. */
function checkLabeledStartup(
  host: StartupCheckHost,
  label: number,
  options: StartupCheckOptions,
): Effect.Effect<StartupCheckReport, StartupCheckProblem> {
  return Effect.gen(function* () {
    const generationLabel = parseGenerationLabel(label);

    const generation =
      generationLabel === undefined ? undefined : host.generations.byLabel(generationLabel);

    if (generationLabel === undefined || generation === undefined) {
      return yield* Effect.fail<StartupCheckProblem>({ code: "unknown-generation", label });
    }

    const moduleMap = yield* host.artifacts.prepare(generation.harnessCommit);

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
