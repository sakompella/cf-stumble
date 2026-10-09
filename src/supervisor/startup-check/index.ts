import { Result } from "better-result";
import type { MainFacetCapabilities } from "../../facet/index.js";
import type { StartupCheckOutcome } from "./body.js";

import { parseGenerationLabel } from "../generations/index.js";
import { timed, type TimedOutcome } from "../../diagnostics.js";
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
    async () => plainStartupCheck(await checkLabeledStartup(host, label, source, options)),
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
): Promise<Result<StartupCheckReport, StartupCheckProblem>> {
  const generationLabel = parseGenerationLabel(label);

  const generation =
    generationLabel === undefined ? undefined : host.generations.byLabel(generationLabel);

  if (generationLabel === undefined || generation === undefined) {
    return Result.err({ code: "unknown-generation", label });
  }

  const moduleMap = await startupModuleMap(host.artifacts, generation, generationLabel, source);

  if (moduleMap.isErr()) {
    return Result.err(moduleMap.error);
  }

  const outcome = await runStartupCheck(host, moduleMap.value, generation.harnessCommit, {
    deadlineMs: options.deadlineMs ?? STARTUP_CHECK_DEADLINE_MS,
    maxBodyBytes: options.maxBodyBytes ?? STARTUP_CHECK_MAX_BODY_BYTES,
  });

  return host.generations
    .recordPreparationCheck(generationLabel, outcome.stage === "ready" ? "passed" : "failed")
    .map((recorded): StartupCheckReport => ({
      ...outcome,
      generation: recorded.generation,
      effect: recorded.effect,
    }));
}

// The check composes a Result and converts once, here, because the Supervisor returns this union
// over RPC from checkGenerationStartup and prepareGeneration (ADR-0035).
function plainStartupCheck(
  result: Result<StartupCheckReport, StartupCheckProblem>,
): StartupCheckResult {
  return result.match<StartupCheckResult>({
    ok: (report) => ({ ok: true, report }),
    err: (problem) => ({ ok: false, problem }),
  });
}
