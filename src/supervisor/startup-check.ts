import { Result, TaggedError } from "better-result";
import { MainHarnessArtifact, loadMainFacet } from "../agent/loader.js";
import type { MainHarnessArtifactInput } from "../agent/loader.js";
import { deadlineAfter } from "./startup-check-deadline.js";
import { drainResponseBody } from "./startup-check-body.js";
import { mainFacetName } from "./facet-name.js";
import { parseGenerationLabel } from "./generation-types.js";
import type { GenerationLabel } from "./generation-types.js";
import type { HarnessArtifactResult, HarnessArtifacts } from "./harness-artifacts.js";
import type { Deadline } from "./startup-check-deadline.js";
import type { Generation, Generations, PreparationCheckResult } from "./generations.js";

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

export type StartupCheckStage =
  | "ready"
  | "mount-failed"
  | "headers-not-received"
  | "response-rejected"
  | "body-failed"
  | "deadline-expired";

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
        | Extract<HarnessArtifactResult, { readonly ok: false }>["problem"]
        | Extract<PreparationCheckResult, { readonly ok: false }>["problem"];
    };

export function checkGenerationStartup(
  ctx: DurableObjectState,
  loader: WorkerLoader,
  artifacts: HarnessArtifacts,
  generations: Generations,
  label: number,
  input: MainHarnessArtifactInput,
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
  options: StartupCheckOptions,
): Promise<StartupCheckResult> {
  const parsedArtifact = MainHarnessArtifact.parse(input);
  if (!parsedArtifact.ok) {
    return parsedArtifact;
  }

  if (parsedArtifact.artifact.harnessCommit !== generation.harnessCommit) {
    return {
      ok: false,
      problem: {
        code: "artifact-harness-commit-mismatch",
        label: generationLabel,
        generationHarnessCommit: generation.harnessCommit,
        artifactHarnessCommit: parsedArtifact.artifact.harnessCommit,
      },
    };
  }

  const retained = artifacts.retain(input);
  if (!retained.ok) {
    return retained;
  }

  const outcome = await runStartupCheck(
    ctx,
    loader,
    retained.artifact,
    generation.harnessCommit,
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
  options: StartupCheckOptions,
): Promise<StartupCheckOutcome> {
  const deadline = deadlineAfter(options.deadlineMs ?? STARTUP_CHECK_DEADLINE_MS);
  const maxBodyBytes = options.maxBodyBytes ?? STARTUP_CHECK_MAX_BODY_BYTES;

  try {
    const loadedFacet = mountCandidateFacet(ctx, loader, input, harnessCommit);
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

export type StartupCheckOutcome =
  | { readonly stage: "ready"; readonly reason: string; readonly status: number }
  | { readonly stage: "response-rejected"; readonly reason: string; readonly status: number }
  | {
      readonly stage: Exclude<StartupCheckStage, "ready" | "response-rejected">;
      readonly reason: string;
    };

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
): Result<Fetcher, MainFacetMountFailed> {
  try {
    const loadedFacet = loadMainFacet(loader, input);
    if (!loadedFacet.ok) {
      const reason = loadedFacet.problem.code;
      return Result.err(
        new MainFacetMountFailed({
          reason,
          message: `Candidate facet for ${harnessCommit} could not mount: ${reason}`,
        }),
      );
    }

    const name = mainFacetName(harnessCommit, "candidate");
    ctx.facets.abort(name, "discard prior startup-check candidate");
    return Result.ok(ctx.facets.get(name, () => ({ class: loadedFacet.facetClass })));
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
  if (!recorded.ok) {
    return recorded;
  }

  return {
    ok: true,
    report: {
      ...outcome,
      generation: recorded.generation,
      effect: recorded.effect,
    },
  };
}
