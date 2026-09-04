import { resolveProjectWorkspaceName } from "../../workspace-names.js";
import type { Result } from "better-result";
import type { AccessIdentity } from "../../access/index.js";
import type { MainFacetTarget } from "../../facet/index.js";
import type { ProjectRpcTargetContract } from "../../workspace/project/protocol.js";
import type { MainFacetMountProblem } from "../artifacts/index.js";
import type { ProjectWorkspaceNamespace } from "./project-workspace.js";

/** The verified tenant a project workspace name is derived from. No request supplies this. */
export type ProjectTenantScope = Readonly<{
  identity: AccessIdentity;
  audience: string;
}>;

/** Mounts the generation that serves. The Supervisor owns the loader, facets, and module maps. */
export type MountServingGeneration = () => Promise<
  Result<{ readonly fetcher: Fetcher<MainFacetTarget> }, MainFacetMountProblem>
>;

/** What a caller asks for. Both untrusted fields are named here so no shell has to declare one. */
export interface ProjectTurnRequest {
  readonly tenant: ProjectTenantScope;
  /** The client-supplied project id. The catalog resolves it before anything is named. */
  readonly projectId: unknown;
  /** The turn request. The generation parses it; nothing on this side reads it. */
  readonly request: unknown;
}

export interface ProjectTurnInput extends ProjectTurnRequest {
  readonly namespace: ProjectWorkspaceNamespace;
  readonly mount: MountServingGeneration;
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

/** The mount problem arrives as a code because a project knows nothing about module maps. */
function mountRefusal(problemCode: string): "no-active-generation" | "mount-failed" {
  return problemCode === "no-active-generation" ? "no-active-generation" : "mount-failed";
}

/**
 * Start one streamed turn against one project's own Computer workspace.
 *
 * The order of the three steps is deliberate. The project id is resolved against the catalog
 * first, so a workspace name exists only for a project the server recognizes and a client string
 * never becomes one. The generation is mounted second, so a Supervisor with nothing serving
 * refuses before obtaining any capability. The capability is obtained last and reaches the
 * generation as an argument of `startTurn`, never as a loader environment entry: the Worker Loader
 * caches its entry under the harness commit, so a capability placed there would be whichever
 * project warmed the cache and would then serve every other project.
 *
 * Nothing disposes the obtained stub here. The generation leases a duplicate that outlives this
 * call, and that duplicate is a reference held through it, so disposing here would cut a running
 * turn off from the files it is working in. Releasing the lease at the turn's end, which
 * `facet/generation-0/project-capability.ts` does, is what ends the whole chain.
 */
export async function startProjectTurn(input: ProjectTurnInput): Promise<ProjectTurnStart> {
  const resolved = await resolveProjectWorkspaceName({
    identity: input.tenant.identity,
    audience: input.tenant.audience,
    projectId: input.projectId,
  });
  if (!resolved.ok) {
    return { ok: false, reason: resolved.reason };
  }

  const mounted = await input.mount();
  if (mounted.isErr()) {
    return { ok: false, reason: mountRefusal(mounted.error.code) };
  }

  let capability: ProjectRpcTargetContract;
  try {
    capability = await input.namespace.getByName(resolved.workspaceName).project();
  } catch {
    return { ok: false, reason: "workspace-unavailable" };
  }

  try {
    return { ok: true, frames: await mounted.value.fetcher.startTurn(capability, input.request) };
  } catch {
    return { ok: false, reason: "turn-not-started" };
  }
}
