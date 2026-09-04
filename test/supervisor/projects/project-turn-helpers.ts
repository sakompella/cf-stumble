import { Result } from "better-result";
import { streamProjectTurn } from "../../../src/supervisor/projects/index.js";
import { resolveProjectWorkspaceName } from "../../../src/workspace-names.js";
import { readFrames } from "../../facet/generation-0/facet-turn-helpers.js";
import { loadFixtureEntrypoint } from "../../loaded-fixture.js";
import type { FacetTurnFrame } from "../../../src/facet/generation-0/facet-turn.js";
import type { ModelRouteResponse } from "../../../src/model-route.js";
import type {
  ProjectTurnFacet,
  ProjectTurnStart,
  ProjectWorkspaceNamespace,
} from "../../../src/supervisor/projects/index.js";
import type LoadedFacetTurnEntry from "../../facet/generation-0/loaded-facet-turn-entry.js";
import type LoadedProjectWorkspacesEntry from "./loaded-project-workspaces-entry.js";

/** One verified tenant. Every name these tests compare is derived from this one identity. */
export const tenant = { identity: "tenant-1", audience: "test-audience" } as const;

const OPENING = { prompt: "do the work", state: null };

/**
 * The Workspace Host stand-in in its own isolate, plus the namespace view the Supervisor's project
 * path uses. `fileText` reads a named workspace directly, so an isolation check does not depend on
 * the capability path it is checking.
 */
export interface ProjectWorkspaces {
  readonly namespace: ProjectWorkspaceNamespace;
  fileText(workspaceName: string, path: string): Promise<string | null>;
  requestedNames(): Promise<string[]>;
}

export async function projectWorkspaces(): Promise<ProjectWorkspaces> {
  const host = await loadFixtureEntrypoint<LoadedProjectWorkspacesEntry>(
    "loaded-project-workspaces-fixture.json",
  );
  return {
    namespace: { getByName: (name) => ({ project: () => host.project(name) }) },
    fileText: (workspaceName, path) => host.fileText(workspaceName, path),
    requestedNames: () => host.requestedNames(),
  };
}

/** A generation running the real turn in its own isolate, answering from a scripted model. */
export function facetRunning(answers: readonly ModelRouteResponse[]): Promise<ProjectTurnFacet> {
  return loadFixtureEntrypoint<LoadedFacetTurnEntry>("loaded-facet-turn-fixture.json", {
    MODEL_SCRIPT: JSON.stringify(answers),
  });
}

/** The workspace name production would derive for this tenant and project id. */
export async function derivedName(projectId: string): Promise<string> {
  const resolved = await resolveProjectWorkspaceName({ ...tenant, projectId });
  if (!resolved.ok) {
    throw new Error("a configured project must resolve");
  }
  return resolved.workspaceName;
}

export function turnFor(
  workspaces: ProjectWorkspaces,
  facet: ProjectTurnFacet,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Mirrors the boundary: a project id arrives from a client with no proven shape.
  projectId: unknown,
): Promise<ProjectTurnStart> {
  return streamProjectTurn({
    namespace: workspaces.namespace,
    mount: () => Promise.resolve(Result.ok({ fetcher: facet })),
    tenant,
    projectId,
    request: OPENING,
  });
}

/** A turn asked for while no generation serves, so nothing is mounted to run it. */
export function turnWithNothingServing(workspaces: ProjectWorkspaces): Promise<ProjectTurnStart> {
  return streamProjectTurn({
    namespace: workspaces.namespace,
    mount: () => Promise.resolve(Result.err({ code: "no-active-generation" })),
    tenant,
    projectId: "project-one",
    request: OPENING,
  });
}

export async function completedTurn(
  workspaces: ProjectWorkspaces,
  facet: ProjectTurnFacet,
  projectId: string,
): Promise<FacetTurnFrame[]> {
  const started = await turnFor(workspaces, facet, projectId);
  if (!started.ok) {
    throw new Error(`the turn must start; it was refused with ${started.reason}`);
  }
  return readFrames(started.frames);
}
