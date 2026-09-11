import type { Project } from "../../project-catalog.js";
import { resolveSelectableProject, type SelectableCatalog } from "../../selectable-projects.js";
import { selectedWorkingDirectory } from "../../workspace-layout.js";
import type { Result } from "better-result";
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
 * It takes a {@link Project}, so the harness selection cannot be handed to it: the harness
 * checkout is provisioned by the bootstrap that clones it and has no repository URL to reconcile
 * against.
 */
export type ProvisionSelectedProject = (project: Project) => Promise<boolean>;

/** Mounts the generation that serves. The Supervisor owns the loader, facets, and module maps. */
export type MountServingGeneration = () => Promise<
  Result<{ readonly fetcher: ProjectTurnFacet }, MainFacetMountProblem>
>;

/** What a caller asks for. Both untrusted fields are named here so no shell has to declare one. */
export interface ProjectTurnRequest {
  /** The client-supplied project id. The catalog resolves it before anything is named. */
  readonly projectId: unknown;
  /** The turn request. The generation parses it; nothing on this side reads it. */
  readonly request: unknown;
}

export interface ProjectTurnInput extends ProjectTurnRequest {
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
  /**
   * The admitted turn's one cancellation. Starting a turn is four calls that can each be lost, and
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

/** A turn that did not begin. The four steps below all end here when the turn is already over. */
const NOT_STARTED = { ok: false, reason: "turn-not-started" } as const satisfies ProjectTurnStart;

/** The mount problem arrives as a code because a project knows nothing about module maps. */
function mountRefusal(problemCode: string): "no-active-generation" | "mount-failed" {
  return problemCode === "no-active-generation" ? "no-active-generation" : "mount-failed";
}

/**
 * Start one streamed turn in the tenant's workspace, against the selected project's directory.
 *
 * The order of the steps is deliberate. The selected id is resolved against the catalog first, so a
 * working directory exists only for something the server recognizes and a client string never
 * becomes a path. The generation is mounted second, so a Supervisor with nothing serving refuses
 * before touching a workspace at all. A selected repository's clone is reconciled third, because a
 * turn that is about to edit files needs them to be there. The capability is obtained last and
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
export async function streamProjectTurn(input: ProjectTurnInput): Promise<ProjectTurnStart> {
  const resolved = resolveSelectableProject(input.projectId, input.catalog);

  if (!resolved.ok) {
    return { ok: false, reason: resolved.reason };
  }

  const selected = resolved.project;

  if (input.signal.aborted) {
    return NOT_STARTED;
  }

  const mounted = await input.mount();

  if (mounted.isErr()) {
    return { ok: false, reason: mountRefusal(mounted.error.code) };
  }

  if (input.signal.aborted) {
    return NOT_STARTED;
  }

  // Only a connected repository has a clone to reconcile. The harness checkout is already in the
  // workspace, so selecting it asks the workspace for nothing before the turn starts.
  if (selected.kind === "repository" && !(await input.provision(selected))) {
    return { ok: false, reason: "workspace-unavailable" };
  }

  if (input.signal.aborted) {
    return NOT_STARTED;
  }

  let capability: ProjectRpcTargetContract;

  try {
    capability = await input.namespace.getByName(input.workspaceName).project();
  } catch {
    return { ok: false, reason: "workspace-unavailable" };
  }

  if (input.signal.aborted) {
    return NOT_STARTED;
  }

  try {
    const frames = await mounted.value.fetcher.startTurn(
      capability,
      input.request,
      selectedWorkingDirectory(selected),
    );

    return endedBeforeItBegan(input, frames);
  } catch {
    return NOT_STARTED;
  }
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

  frames.cancel().then(
    () => {},
    () => {},
  );

  return NOT_STARTED;
}
