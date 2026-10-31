import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { loadMainFacet } from "../../facet/index.js";
import type { MainFacetTarget, MainHarnessArtifact } from "../../facet/index.js";
import { FACET_COMPATIBILITY } from "../../facet-compatibility.js";
import { candidateFacetName } from "../artifacts/index.js";
import type { StartupCheckHost } from "./index.js";

export type StartupCheckOutcome = Readonly<{
  stage: "ready" | "mount-failed" | "deadline-expired" | "compatibility-mismatch";
  reason: string;
}>;

export function runStartupCheck(
  host: StartupCheckHost,
  artifact: MainHarnessArtifact,
  deadlineMs: number,
): Effect.Effect<StartupCheckOutcome> {
  const candidate = mountCandidateFacet(host, artifact);

  if (Result.isFailure(candidate)) {
    return Effect.succeed({ stage: "mount-failed", reason: candidate.failure });
  }

  return Effect.tryPromise({
    try: () => candidate.success.compatibility(),
    catch: (cause) => (cause instanceof Error ? cause.message : String(cause)),
  }).pipe(
    Effect.match({
      onSuccess: compatibilityOutcome,
      onFailure: (reason): StartupCheckOutcome => ({
        stage: "mount-failed",
        reason: `the candidate did not answer compatibility: ${reason}`,
      }),
    }),
    Effect.timeoutOrElse({
      duration: deadlineMs,
      orElse: () =>
        Effect.succeed<StartupCheckOutcome>({
          stage: "deadline-expired",
          reason: "the facet compatibility answer exceeded the deadline",
        }),
    }),
  );
}

function compatibilityOutcome(reported: string): StartupCheckOutcome {
  return reported === FACET_COMPATIBILITY
    ? { stage: "ready", reason: `the generation reports ${reported}` }
    : {
        stage: "compatibility-mismatch",
        reason: `the generation reports ${reported}; this Supervisor requires ${FACET_COMPATIBILITY}`,
      };
}

function mountCandidateFacet(
  host: StartupCheckHost,
  artifact: MainHarnessArtifact,
): Result.Result<Fetcher<MainFacetTarget>, string> {
  try {
    const { facetClass } = loadMainFacet(host.loader, artifact, { MODEL: host.modelRoute() });
    const name = candidateFacetName(artifact.harnessCommit);
    host.ctx.facets.abort(name, "discard prior startup-check candidate");

    return Result.succeed(host.ctx.facets.get(name, () => ({ class: facetClass })));
  } catch {
    return Result.fail("candidate facet could not mount");
  }
}
