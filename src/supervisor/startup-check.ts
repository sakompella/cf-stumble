import { MainHarnessArtifact, loadMainFacet } from "../agent/loader.js";
import type { MainHarnessArtifactInput, MainHarnessArtifactProblem } from "../agent/loader.js";
import { deadlineAfter } from "./startup-check-deadline.js";
import { drainResponseBody } from "./startup-check-body.js";
import { mainFacetName } from "./facet-name.js";
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
        | MainHarnessArtifactProblem
        | Extract<PreparationCheckResult, { readonly ok: false }>["problem"];
    };

export async function checkGenerationStartup(
  ctx: DurableObjectState,
  loader: WorkerLoader,
  generations: Generations,
  label: number,
  input: MainHarnessArtifactInput,
  options: StartupCheckOptions = {},
): Promise<StartupCheckResult> {
  const generation = generations.byLabel(label);
  if (generation === undefined) {
    return { ok: false, problem: { code: "unknown-generation", label } };
  }

  const parsedArtifact = MainHarnessArtifact.parse(input);
  if (!parsedArtifact.ok) {
    return parsedArtifact;
  }

  if (parsedArtifact.artifact.harnessCommit.value !== generation.harnessCommit) {
    return {
      ok: false,
      problem: {
        code: "artifact-harness-commit-mismatch",
        label,
        generationHarnessCommit: generation.harnessCommit,
        artifactHarnessCommit: parsedArtifact.artifact.harnessCommit.value,
      },
    };
  }

  const outcome = await runStartupCheck(ctx, loader, input, generation.harnessCommit, options);
  const recorded = generations.recordPreparationCheck(
    label,
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
    if (loadedFacet.ok) {
      return await classifyCandidateResponse(loadedFacet.fetcher, deadline, maxBodyBytes);
    }

    return loadedFacet;
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
  if (!response.ok) {
    return response;
  }

  if (response.response.status >= 500) {
    return {
      stage: "response-rejected",
      reason: `response status was ${response.response.status}`,
      status: response.response.status,
    };
  }

  return drainResponseBody(response.response, deadline, maxBodyBytes);
}

export type StartupCheckOutcome =
  | { readonly stage: "ready"; readonly reason: string; readonly status: number }
  | { readonly stage: "response-rejected"; readonly reason: string; readonly status: number }
  | {
      readonly stage: Exclude<StartupCheckStage, "ready" | "response-rejected">;
      readonly reason: string;
    };

type CandidateFacet =
  | { readonly ok: true; readonly fetcher: Fetcher }
  | { readonly ok: false; readonly stage: "mount-failed"; readonly reason: string };

type HeaderResult =
  | { readonly ok: true; readonly response: Response }
  | {
      readonly ok: false;
      readonly stage: Exclude<StartupCheckStage, "ready" | "response-rejected" | "body-failed">;
      readonly reason: string;
    };

function mountCandidateFacet(
  ctx: DurableObjectState,
  loader: WorkerLoader,
  input: MainHarnessArtifactInput,
  harnessCommit: string,
): CandidateFacet {
  try {
    const loadedFacet = loadMainFacet(loader, input);
    if (!loadedFacet.ok) {
      return { ok: false, stage: "mount-failed", reason: loadedFacet.problem.code };
    }

    const name = mainFacetName(harnessCommit, "candidate");
    ctx.facets.abort(name, "discard prior startup-check candidate");
    return {
      ok: true,
      fetcher: ctx.facets.get(name, () => ({ class: loadedFacet.facetClass })),
    };
  } catch {
    return { ok: false, stage: "mount-failed", reason: "candidate facet could not mount" };
  }
}

async function responseBeforeDeadline(fetcher: Fetcher, deadline: Deadline): Promise<HeaderResult> {
  const result = await Promise.race([
    fetcher.fetch(new Request("https://main-facet.invalid/")).then(
      (response) => ({ kind: "response" as const, response }),
      (error: ThrownValue) => ({ kind: "failure" as const, error }),
    ),
    deadline.elapsed.then(() => ({ kind: "deadline" as const })),
  ]);

  if (result.kind === "deadline") {
    return {
      ok: false,
      stage: "deadline-expired",
      reason: "response headers exceeded the deadline",
    };
  }

  if (result.kind === "failure") {
    return { ok: false, stage: "headers-not-received", reason: errorReason(result.error) };
  }

  return { ok: true, response: result.response };
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
