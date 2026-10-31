import * as Effect from "effect/Effect";
import type { MainFacetCapabilities } from "../../facet/index.js";
import { PI_DURABLE_VERSION } from "../../pi-durable-version.js";
import type { HarnessArtifacts, ModuleMapProblem } from "../artifacts/index.js";
import type {
  Generation,
  GenerationLabel,
  Generations,
  PreparationRecord,
} from "../generations.js";
import { runStartupCheck, type StartupCheckOutcome } from "./candidate.js";

const STARTUP_CHECK_DEADLINE_MS = 5_000;

export type StartupCheckHost = Readonly<{
  ctx: DurableObjectState;
  loader: WorkerLoader;
  artifacts: HarnessArtifacts;
  generations: Generations;
  modelRoute: () => MainFacetCapabilities["MODEL"];
}>;

export type StartupCheckOptions = {
  readonly deadlineMs?: number;
};

type StartupCheckReport = StartupCheckOutcome &
  Readonly<{ generation: Generation; effect: PreparationRecord["effect"] }>;

type StartupCheckProblem =
  | { readonly code: "unknown-generation"; readonly label: number }
  | ModuleMapProblem;

export type StartupCheckResult =
  | { readonly ok: true; readonly report: StartupCheckReport }
  | { readonly ok: false; readonly problem: StartupCheckProblem };

export function checkGenerationStartup(
  host: StartupCheckHost,
  label: GenerationLabel,
  options: StartupCheckOptions = {},
): Effect.Effect<StartupCheckResult> {
  return checkLabeledStartup(host, label, options).pipe(
    Effect.match({
      onSuccess: (report): StartupCheckResult => ({ ok: true, report }),
      onFailure: (problem): StartupCheckResult => ({ ok: false, problem }),
    }),
  );
}

function checkLabeledStartup(
  host: StartupCheckHost,
  label: GenerationLabel,
  options: StartupCheckOptions,
): Effect.Effect<StartupCheckReport, StartupCheckProblem> {
  return Effect.gen(function* () {
    const unknown: StartupCheckProblem = { code: "unknown-generation", label };
    const generation = host.generations.byLabel(label);

    if (generation === undefined) return yield* Effect.fail(unknown);

    const moduleMap = yield* host.artifacts.prepare(generation.harnessCommit);

    const outcome = yield* runStartupCheck(
      host,
      moduleMap,
      options.deadlineMs ?? STARTUP_CHECK_DEADLINE_MS,
    );

    const recorded = host.generations.recordPreparation(
      label,
      outcome.stage === "ready"
        ? { status: "ready", piDurableVersion: PI_DURABLE_VERSION }
        : { status: "failed" },
    );

    if (recorded === undefined) return yield* Effect.fail(unknown);

    return { ...outcome, generation: recorded.record.generation, effect: recorded.effect };
  });
}
