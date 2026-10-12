import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import type { Project } from "../../project-catalog.js";
import { timedWorkspaceRpc } from "../../diagnostics.js";
import { waitForWorkspaceProvision } from "../../workspace/index.js";
import {
  resolveSelectableProject,
  type SelectableCatalog,
  type SelectableProject,
} from "../../selectable-projects.js";
import { selectedWorkingDirectory } from "../../workspace-layout.js";
import type { ProjectRpcTargetContract } from "../../workspace/project/protocol.js";
import type { MainFacetMountProblem } from "../artifacts/index.js";
import type { ProjectWorkspaceNamespace } from "./project-workspace.js";

/**
 * The one thing this path calls on a mounted generation. It is narrower than `MainFacetTarget` on
 * purpose: starting a project turn needs `startTurn` and nothing else, so a generation's request
 * surface is not reachable from here.
 */
export type ProjectTurnFacet = Readonly<{
  startTurn(
    projectTarget: ProjectRpcTargetContract,
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Boundary: the generation parses the turn request; nothing on this side proves its shape.
    request: unknown,
    workingDirectory: string,
  ): Promise<ReadableStream<Uint8Array>>;
}>;

/**
 * Reconcile the selected repository's clone before the turn runs, answering whether the workspace
 * is ready. Provisioning is idempotent (`workspace/provisioning.ts`), so this runs on every turn
 * and is also what repairs a workspace the platform recreated between two turns.
 *
 * It takes a {@link Project}, so the harness selection uses the separate generation-bound
 * provisioner instead of inventing a repository-less catalog project.
 */
type ProvisionSelectedProject = (project: Project, signal: AbortSignal) => Effect.Effect<boolean>;

/** Reconciles the editable harness checkout before its working directory is mounted. */
type ProvisionHarness = (signal: AbortSignal) => Effect.Effect<boolean>;

/** Mounts the generation that serves. The Supervisor owns the loader, facets, and module maps. */
type MountServingGeneration = () => Effect.Effect<
  { readonly fetcher: ProjectTurnFacet },
  MainFacetMountProblem
>;

/** What a caller asks for. Both untrusted fields are named here so no shell has to declare one. */
interface ProjectTurnRequest {
  /** The client-supplied project id. The catalog resolves it before anything is named. */
  readonly projectId: unknown;
  /** The turn request. The generation parses it; nothing on this side reads it. */
  readonly request: unknown;
}

interface ProjectTurnInput extends ProjectTurnRequest {
  /**
   * The tenant's one workspace. The Supervisor derives this name from its own server-derived
   * tenant key, so it is not a field of {@link ProjectTurnRequest} and a client cannot present
   * one.
   */
  readonly workspaceName: string;
  /** Everything the tenant may select. Required, so a turn never resolves against a guess. */
  readonly catalog: SelectableCatalog;
  readonly namespace: ProjectWorkspaceNamespace;
  readonly mount: MountServingGeneration;
  readonly provision: ProvisionSelectedProject;
  /** The harness provisioner is bound to the admitted generation's validated commit. */
  readonly provisionHarness?: ProvisionHarness | undefined;
  /**
   * The admitted turn's one cancellation. Starting a turn makes several calls that can each be lost, and
   * this is what stops the next one from being made once the turn is over.
   */
  readonly signal: AbortSignal;
}

/**
 * Why no turn started. `no-active-generation` is not a fault: nothing failed, there was no main
 * harness to run the turn. The two project-id reasons come from the catalog, so an unrecognized id
 * is refused before a workspace name exists for it.
 */
export type ProjectTurnRefusal =
  | "invalid-project-id"
  | "unknown-project-id"
  | "no-active-generation"
  | "mount-failed"
  | "workspace-unavailable"
  | "turn-not-started";

export type ProjectTurnStart =
  | Readonly<{ ok: true; frames: ReadableStream<Uint8Array> }>
  | Readonly<{ ok: false; reason: ProjectTurnRefusal }>;

/** A turn that did not begin. Every start step ends here when the turn is already over. */
const NOT_STARTED = { ok: false, reason: "turn-not-started" } as const satisfies ProjectTurnStart;

/** The mount problem arrives as a code because a project knows nothing about module maps. */
function mountRefusal(problemCode: string): "no-active-generation" | "mount-failed" {
  return problemCode === "no-active-generation" ? "no-active-generation" : "mount-failed";
}

type WorkspacePreparation = "ready" | "aborted" | "unavailable";

function prepareWorkspace(
  input: ProjectTurnInput,
  selected: SelectableProject,
): Effect.Effect<WorkspacePreparation> {
  return Effect.gen(function* () {
    if (!(yield* workspaceIsAvailable(input))) return "aborted";

    if (
      selected.kind === "harness" &&
      input.provisionHarness !== undefined &&
      !(yield* input.provisionHarness(input.signal))
    ) {
      return input.signal.aborted ? "aborted" : "unavailable";
    }

    return input.signal.aborted ? "aborted" : "ready";
  });
}

/**
 * Start one streamed turn in the tenant's workspace, against the selected project's directory.
 *
 * The order of the steps is deliberate. The selected id is resolved against the catalog first, so a
 * working directory exists only for something the server recognizes and a client string never
 * becomes a path. A harness checkout is reconciled before its generation mounts, while a Supervisor
 * with nothing serving refuses before touching a workspace at all. A selected repository's clone is
 * reconciled after mounting, because it is independent of whether a generation exists. The
 * capability is obtained last and
 * reaches the generation as an argument of `startTurn`, never as a loader environment entry: the
 * Worker Loader caches its entry under the harness commit, so a capability placed there would be
 * whichever project warmed the cache and would then serve every other project.
 *
 * Selecting a project sets the turn's initial working directory and nothing else (ADR-0038), and
 * that holds for the harness entry too: it is `/workspace/harness`, reached with the same
 * capability, the same lease and the same thread rules as any repository. The capability addresses
 * the whole workspace, so the agent can still read a sibling repository or the managed
 * instructions when the work needs it; what it cannot do is reach another tenant, because the
 * workspace name comes from the Supervisor's own tenant key rather than from the request.
 *
 * Nothing disposes the obtained stub here. The generation leases a duplicate that outlives this
 * call, and that duplicate is a reference held through it, so disposing here would cut a running
 * turn off from the files it is working in. Releasing the lease at the turn's end, which
 * `facet/generation-0/project-capability.ts` does, is what ends the whole chain.
 */
export function startFacetTurn(input: ProjectTurnInput): Effect.Effect<ProjectTurnStart> {
  return Effect.gen(function* () {
    const resolved = resolveSelectableProject(input.projectId, input.catalog);

    if (!resolved.ok) {
      return { ok: false, reason: resolved.reason };
    }

    const selected = resolved.project;

    if (input.signal.aborted) {
      return NOT_STARTED;
    }

    const preparation = yield* prepareWorkspace(input, selected);

    if (preparation === "aborted") return NOT_STARTED;

    if (preparation === "unavailable") {
      return { ok: false, reason: "workspace-unavailable" };
    }

    const mounted = yield* Effect.result(input.mount());

    if (Result.isFailure(mounted)) {
      return { ok: false, reason: mountRefusal(mounted.failure.code) };
    }

    if (input.signal.aborted) {
      return NOT_STARTED;
    }

    // Connected repositories are reconciled after the generation is mounted. Their checkout does
    // not determine whether this generation exists, while the harness checkout does.
    if (selected.kind === "repository" && !(yield* input.provision(selected, input.signal))) {
      return { ok: false, reason: "workspace-unavailable" };
    }

    if (input.signal.aborted) {
      return NOT_STARTED;
    }

    const capability = yield* obtainCapability(input);

    if (capability === null) {
      return { ok: false, reason: "workspace-unavailable" };
    }

    if (input.signal.aborted) {
      return NOT_STARTED;
    }

    if (!(yield* workspaceIsAvailable(input))) return NOT_STARTED;

    const frames = yield* facetStream(() =>
      mounted.success.fetcher.startTurn(
        capability,
        input.request,
        selectedWorkingDirectory(selected),
      ),
    );

    return frames === null ? NOT_STARTED : endedBeforeItBegan(input, frames);
  });
}

/** Ask the tenant's Workspace Host for the project capability, or learn that it cannot answer. */
function obtainCapability(input: ProjectTurnInput): Effect.Effect<ProjectRpcTargetContract | null> {
  return Effect.promise(() =>
    timedWorkspaceRpc(
      { method: "project" },
      () => input.namespace.getByName(input.workspaceName).project(),
      () => ({ outcome: "ok" }),
    ).then(
      (capability) => capability,
      () => null,
    ),
  );
}

/** Wait for provision before generation or capability admission, including harness turns. */
function workspaceIsAvailable(input: ProjectTurnInput): Effect.Effect<boolean> {
  return waitForWorkspaceProvision(input.workspaceName, input.signal);
}

/**
 * Ask the facet to begin, or learn that it could not. A facet's answer is a live stream with work
 * already running behind it, so a start interrupted while the answer is on its way cancels that
 * stream when it arrives instead of leaving it unread.
 */
function facetStream(
  begin: () => Promise<ReadableStream<Uint8Array>>,
): Effect.Effect<ReadableStream<Uint8Array> | null> {
  return Effect.suspend(() => {
    let answer: Promise<ReadableStream<Uint8Array> | null>;

    try {
      answer = begin().then(
        (frames) => frames,
        () => null,
      );
    } catch {
      return Effect.succeed(null);
    }

    return Effect.promise(() => answer).pipe(
      Effect.onInterrupt(() =>
        Effect.sync(() => {
          void answer.then(cancelUnread);
        }),
      ),
    );
  });
}

function cancelUnread(frames: ReadableStream<Uint8Array> | null): void {
  frames?.cancel().then(
    () => {},
    () => {},
  );
}

/**
 * A turn whose bound passed while the facet was starting. The facet answered with a live stream
 * and has already begun the work behind it, so the stream is cancelled rather than returned: that
 * is what ends a turn nobody will read (`facet/generation-0/facet-turn.ts`).
 */
function endedBeforeItBegan(
  input: ProjectTurnInput,
  frames: ReadableStream<Uint8Array>,
): ProjectTurnStart {
  if (!input.signal.aborted) {
    return { ok: true, frames };
  }

  cancelUnread(frames);

  return NOT_STARTED;
}
