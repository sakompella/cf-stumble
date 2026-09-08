import { Result } from "better-result";
import { streamProjectTurn } from "../../../src/supervisor/projects/index.js";
import { tenantWorkspaceName } from "../../../src/workspace-names.js";
import { sampleCatalog, sampleProjectOne } from "../../project-fixtures.js";
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

/**
 * The tenant's one workspace, as the Supervisor names it from its own server-derived name. Every
 * project of this tenant reaches this one name; a second tenant is a second Supervisor and so a
 * second name.
 */
export const workspaceName = tenantWorkspaceName("supervisor-name-of-tenant-one");
export const otherTenantWorkspaceName = tenantWorkspaceName("supervisor-name-of-tenant-two");

const OPENING = { prompt: "do the work", state: null };

/**
 * These tests drive their own Workspace Host stand-in, which holds the files the turn works on
 * already. Provisioning is exercised by the provisioning tests; here it only has to not refuse.
 */
const provisioned = (): Promise<boolean> => Promise.resolve(true);

/** The signal of a turn that is still within its bound, which is what an ordinary start carries. */
export function runningTurn(): AbortSignal {
  return new AbortController().signal;
}

/**
 * The Workspace Host stand-in in its own isolate, plus the namespace view the Supervisor's project
 * path uses. `fileText` reads a named workspace directly, so an isolation check does not depend on
 * the capability path it is checking.
 */
export interface ProjectWorkspaces {
  readonly namespace: ProjectWorkspaceNamespace;
  fileText(name: string, path: string): Promise<string | null>;
  requestedNames(): Promise<string[]>;
}

export async function projectWorkspaces(): Promise<ProjectWorkspaces> {
  const host = await loadFixtureEntrypoint<LoadedProjectWorkspacesEntry>(
    "loaded-project-workspaces-fixture.json",
  );
  return {
    namespace: { getByName: (name) => ({ project: () => host.project(name) }) },
    fileText: (name, path) => host.fileText(name, path),
    requestedNames: () => host.requestedNames(),
  };
}

/** A generation running the real turn in its own isolate, answering from a scripted model. */
export function facetRunning(answers: readonly ModelRouteResponse[]): Promise<ProjectTurnFacet> {
  return loadFixtureEntrypoint<LoadedFacetTurnEntry>("loaded-facet-turn-fixture.json", {
    MODEL_SCRIPT: JSON.stringify(answers),
  });
}

export function turnFor(
  workspaces: ProjectWorkspaces,
  facet: ProjectTurnFacet,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Mirrors the boundary: a project id arrives from a client with no proven shape.
  projectId: unknown,
  /** Only a second tenant's Supervisor supplies a different name; no request can. */
  tenantWorkspace: string = workspaceName,
  signal: AbortSignal = runningTurn(),
): Promise<ProjectTurnStart> {
  return streamProjectTurn({
    namespace: workspaces.namespace,
    mount: () => Promise.resolve(Result.ok({ fetcher: facet })),
    provision: provisioned,
    catalog: sampleCatalog,
    workspaceName: tenantWorkspace,
    projectId,
    request: OPENING,
    signal,
  });
}

/** A turn asked for while no generation serves, so nothing is mounted to run it. */
export function turnWithNothingServing(workspaces: ProjectWorkspaces): Promise<ProjectTurnStart> {
  return streamProjectTurn({
    namespace: workspaces.namespace,
    mount: () => Promise.resolve(Result.err({ code: "no-active-generation" })),
    provision: provisioned,
    catalog: sampleCatalog,
    workspaceName,
    projectId: sampleProjectOne.id,
    request: OPENING,
    signal: runningTurn(),
  });
}

export async function completedTurn(
  workspaces: ProjectWorkspaces,
  facet: ProjectTurnFacet,
  projectId: string,
  tenantWorkspace: string = workspaceName,
): Promise<FacetTurnFrame[]> {
  const started = await turnFor(workspaces, facet, projectId, tenantWorkspace);
  if (!started.ok) {
    throw new Error(`the turn must start; it was refused with ${started.reason}`);
  }
  return readFrames(started.frames);
}
