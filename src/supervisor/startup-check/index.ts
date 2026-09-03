import { Result, TaggedError } from "better-result";
import { MainHarnessArtifact, loadMainFacet } from "../../facet/index.js";
import type { MainFacetCapabilities, MainHarnessArtifactInput } from "../../facet/index.js";
import { deadlineAfter } from "./deadline.js";
import type { StartupCheckOutcome } from "./body.js";
import { drainResponseBody } from "./body.js";
export type { StartupCheckOutcome, StartupCheckStage } from "./body.js";
import { mainFacetName } from "../artifacts/index.js";
import { parseGenerationLabel } from "../generations/index.js";
import type { GenerationLabel } from "../generations/index.js";
import type { HarnessArtifactProblem, HarnessArtifacts } from "../artifacts/index.js";
import type { Deadline } from "./deadline.js";
import type {
  Generation,
  Generations,
  PreparationCheckProblem,
  PreparationCheckResult,
} from "../generations/index.js";

type ThrownValue = Error | string | number | boolean | null | undefined;

function errorReason(error: ThrownValue): string {
  return error instanceof Error ? error.message : String(error);
}

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
        | {
            readonly code: "artifact-harness-commit-mismatch";
            readonly label: number;
            readonly generationHarnessCommit: string;
            readonly artifactHarnessCommit: string;
          }
        | HarnessArtifactProblem
        | PreparationCheckProblem;
    };

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
    input,
    modelRoute,
    options,
  );
}

async function checkKnownGenerationStartup(
  ctx: DurableObjectState,
  loader: WorkerLoader,
  artifacts: HarnessArtifacts,
  generations: Generations,
  generationLabel: GenerationLabel,
  generation: Generation,
  input: MainHarnessArtifactInput,
  modelRoute: MainFacetCapabilities["MODEL"],
  options: StartupCheckOptions,
): Promise<StartupCheckResult> {
  const parsedArtifact = MainHarnessArtifact.parse(input);
  if (parsedArtifact.isErr()) {
    return { ok: false, problem: parsedArtifact.error };
  }

  if (parsedArtifact.value.harnessCommit !== generation.harnessCommit) {
    return {
      ok: false,
      problem: {
        code: "artifact-harness-commit-mismatch",
        label: generationLabel,
        generationHarnessCommit: generation.harnessCommit,
        artifactHarnessCommit: parsedArtifact.value.harnessCommit,
      },
    };
  }

  const retained = await artifacts.retain(input);
  if (retained.isErr()) {
    return { ok: false, problem: retained.error };
  }

  const outcome = await runStartupCheck(
    ctx,
    loader,
    retained.value.artifact,
    generation.harnessCommit,
    modelRoute,
    options,
  );
  const recorded = generations.recordPreparationCheck(
    generationLabel,
    outcome.stage === "ready" ? "passed" : "failed",
  );

  return startupCheckResult(outcome, recorded);
}

async function runStartupCheck(
  ctx: DurableObjectState,
  loader: WorkerLoader,
  input: MainHarnessArtifactInput,
  harnessCommit: string,
  modelRoute: MainFacetCapabilities["MODEL"],
  options: StartupCheckOptions,
): Promise<StartupCheckOutcome> {
  const deadline = deadlineAfter(options.deadlineMs ?? STARTUP_CHECK_DEADLINE_MS);
  const maxBodyBytes = options.maxBodyBytes ?? STARTUP_CHECK_MAX_BODY_BYTES;

  try {
    const loadedFacet = mountCandidateFacet(ctx, loader, input, harnessCommit, modelRoute);
    if (loadedFacet.isErr()) {
      return loadedFacet.error.match({
        MainFacetMountFailed: (error): StartupCheckOutcome => ({
          stage: "mount-failed",
          reason: error.reason,
        }),
      });
    }

    return await classifyCandidateResponse(loadedFacet.value, deadline, maxBodyBytes);
  } finally {
    deadline.cancel();
  }
}

async function classifyCandidateResponse(
  fetcher: Fetcher,
  deadline: Deadline,
  maxBodyBytes: number,
): Promise<StartupCheckOutcome> {
  const response = await responseBeforeDeadline(fetcher, deadline);
  if (response.isErr()) {
    return response.error.match({
      StartupHeadersNotReceived: (error): StartupCheckOutcome => ({
        stage: "headers-not-received",
        reason: error.reason,
      }),
      StartupHeaderDeadlineExceeded: (error): StartupCheckOutcome => ({
        stage: "deadline-expired",
        reason: error.reason,
      }),
    });
  }

  if (response.value.status >= 400) {
    return {
      stage: "response-rejected",
      reason: `response status was ${response.value.status}`,
      status: response.value.status,
    };
  }

  return drainResponseBody(response.value, deadline, maxBodyBytes);
}

class MainFacetMountFailed extends TaggedError("MainFacetMountFailed")<{
  readonly reason: string;
  readonly message: string;
}> {}

class StartupHeadersNotReceived extends TaggedError("StartupHeadersNotReceived")<{
  readonly reason: string;
  readonly message: string;
}> {}

class StartupHeaderDeadlineExceeded extends TaggedError("StartupHeaderDeadlineExceeded")<{
  readonly reason: string;
  readonly message: string;
}> {}

type HeaderFailure = StartupHeadersNotReceived | StartupHeaderDeadlineExceeded;

function mountCandidateFacet(
  ctx: DurableObjectState,
  loader: WorkerLoader,
  input: MainHarnessArtifactInput,
  harnessCommit: string,
  modelRoute: MainFacetCapabilities["MODEL"],
): Result<Fetcher, MainFacetMountFailed> {
  try {
    const loadedFacet = loadMainFacet(loader, input, { MODEL: modelRoute });
    if (loadedFacet.isErr()) {
      const reason = loadedFacet.error.code;
      return Result.err(
        new MainFacetMountFailed({
          reason,
          message: `Candidate facet for ${harnessCommit} could not mount: ${reason}`,
        }),
      );
    }

    const name = mainFacetName(harnessCommit, "candidate");
    ctx.facets.abort(name, "discard prior startup-check candidate");
    return Result.ok(ctx.facets.get(name, () => ({ class: loadedFacet.value.facetClass })));
  } catch {
    const reason = "candidate facet could not mount";
    return Result.err(new MainFacetMountFailed({ reason, message: reason }));
  }
}

function responseBeforeDeadline(
  fetcher: Fetcher,
  deadline: Deadline,
): Promise<Result<Response, HeaderFailure>> {
  return Promise.race([
    fetcher.fetch(new Request("https://main-facet.invalid/")).then(
      (response) => Result.ok<Response, HeaderFailure>(response),
      (error: ThrownValue) => {
        const reason = errorReason(error);
        return Result.err<Response, HeaderFailure>(
          new StartupHeadersNotReceived({
            reason,
            message: `Startup-check response headers were not received: ${reason}`,
          }),
        );
      },
    ),
    deadline.elapsed.then(() => {
      const reason = "response headers exceeded the deadline";
      return Result.err<Response, HeaderFailure>(
        new StartupHeaderDeadlineExceeded({ reason, message: reason }),
      );
    }),
  ]);
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
