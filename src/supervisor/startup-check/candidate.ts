import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { loadMainFacet } from "../../facet/index.js";
import type { MainFacetTarget, MainHarnessArtifact } from "../../facet/index.js";
import { FACET_COMPATIBILITY } from "../../facet-compatibility.js";
import { candidateFacetName } from "../artifacts/index.js";
import { checkConversation } from "./conversation.js";
import type { StartupCheckHost } from "./index.js";

export type StartupCheckOutcome = Readonly<{
  stage:
    | "ready"
    | "mount-failed"
    | "deadline-expired"
    | "compatibility-mismatch"
    | "conversation-failed";
  reason: string;
}>;

export type StartupCheckDeadlines = Readonly<{ compatibilityMs: number; conversationMs: number }>;

export function runStartupCheck(
  host: StartupCheckHost,
  artifact: MainHarnessArtifact,
  deadlines: StartupCheckDeadlines,
): Effect.Effect<StartupCheckOutcome> {
  const name = candidateFacetName(artifact.harnessCommit);

  const discard = Effect.sync(() => {
    host.ctx.facets.delete(name);
  });

  return discard.pipe(
    Effect.andThen(checkCandidate(host, artifact, deadlines)),
    Effect.ensuring(discard),
  );
}

function withinDeadline(
  durationMs: number,
  reason: string,
): <A>(check: Effect.Effect<A>) => Effect.Effect<A | StartupCheckOutcome> {
  return Effect.timeoutOrElse({
    duration: durationMs,
    orElse: () => Effect.succeed<StartupCheckOutcome>({ stage: "deadline-expired", reason }),
  });
}

function checkCandidate(
  host: StartupCheckHost,
  artifact: MainHarnessArtifact,
  deadlines: StartupCheckDeadlines,
): Effect.Effect<StartupCheckOutcome> {
  return Effect.gen(function* () {
    const candidate = mountCandidateFacet(host, artifact);

    if (Result.isFailure(candidate)) return { stage: "mount-failed", reason: candidate.failure };

    const incompatible = yield* compatibilityProblem(candidate.success).pipe(
      withinDeadline(
        deadlines.compatibilityMs,
        "the facet compatibility answer exceeded the deadline",
      ),
    );

    if (incompatible !== undefined) return incompatible;

    const previous = yield* previousArtifact(host, artifact);
    const name = candidateFacetName(artifact.harnessCommit);
    const writer = remount(host, previous, name);

    if (Result.isFailure(writer)) return { stage: "mount-failed", reason: writer.failure };

    return yield* checkConversation(
      writer.success,
      () => Effect.fromResult(remount(host, artifact, name)),
      (signal) => host.workspace(deadlines.conversationMs, signal),
    ).pipe(
      withinDeadline(
        deadlines.conversationMs,
        "the startup-check conversation did not settle within the deadline",
      ),
    );
  });
}

function previousArtifact(
  host: StartupCheckHost,
  candidate: MainHarnessArtifact,
): Effect.Effect<MainHarnessArtifact> {
  const serving = host.generations.active().generation;

  return serving === undefined
    ? Effect.succeed(candidate)
    : host.artifacts.prepare(serving.harnessCommit).pipe(Effect.orElseSucceed(() => candidate));
}

function remount(host: StartupCheckHost, artifact: MainHarnessArtifact, name: string) {
  host.ctx.facets.abort(name, "the startup check remounts");

  return mountCandidateFacet(host, artifact, name);
}

function compatibilityProblem(
  candidate: Fetcher<MainFacetTarget>,
): Effect.Effect<StartupCheckOutcome | undefined> {
  return Effect.tryPromise({
    try: () => candidate.compatibility(),
    catch: (cause) => (cause instanceof Error ? cause.message : String(cause)),
  }).pipe(
    Effect.match({
      onFailure: (reason): StartupCheckOutcome => ({
        stage: "mount-failed",
        reason: `the candidate did not answer compatibility: ${reason}`,
      }),
      onSuccess: (reported): StartupCheckOutcome | undefined =>
        reported === FACET_COMPATIBILITY
          ? undefined
          : {
              stage: "compatibility-mismatch",
              reason: `the generation reports ${reported}; this Supervisor requires ${FACET_COMPATIBILITY}`,
            },
    }),
  );
}

function mountCandidateFacet(
  host: StartupCheckHost,
  artifact: MainHarnessArtifact,
  facetName: string = candidateFacetName(artifact.harnessCommit),
): Result.Result<Fetcher<MainFacetTarget>, string> {
  try {
    const capabilities = { MODEL: host.model() };

    const { facetClass } = loadMainFacet(
      host.loader,
      artifact,
      capabilities,
      candidateFacetName(artifact.harnessCommit),
    );

    return Result.succeed(host.ctx.facets.get(facetName, () => ({ class: facetClass })));
  } catch {
    return Result.fail("candidate facet could not mount");
  }
}
