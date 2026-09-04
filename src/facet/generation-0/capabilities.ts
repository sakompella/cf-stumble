import type {
  ModelRouteRequest,
  ModelRouteResponse,
  ValidationFailure,
} from "../../model-route.js";
import type { WorkspaceRequest, WorkspaceResult } from "../../workspace/index.js";

/**
 * The model capability the host hands a Generation 0 facet. It carries messages and tools only:
 * the immutable `src/model-route.ts` owns the model, the reasoning effort, the endpoint, and the
 * credential, so nothing in this generation can select or override them.
 */
export type ModelCapability = Readonly<{
  run(request: ModelRouteRequest): Promise<ModelRouteResponse | ValidationFailure>;
}>;

/**
 * The workspace capability the buffered `POST /turn` path uses when a caller supplies one. It is
 * the Workspace Host's own `execute` surface, so this generation reuses that contract instead of
 * describing a second one, and it receives plain results rather than a Computer workspace, a
 * container API, or a binding.
 *
 * It is not part of {@link Generation0Capabilities}, and cannot be: a capability belongs to one
 * project, and this generation's environment is a Worker Loader entry cached under the harness
 * commit and shared by every project the generation serves. The streamed turn takes a project
 * capability as an argument of `MainFacet.startTurn` for that reason.
 */
export type WorkspaceCapability = Readonly<{
  execute(request: WorkspaceRequest): Promise<WorkspaceResult>;
}>;

/**
 * Everything a Generation 0 facet's environment holds. Capabilities only: no raw binding, no
 * credential, no model name, no reasoning level, and no session store, because the saved document
 * arrives with the turn request and leaves with the turn response.
 *
 * Only a generation-invariant capability belongs here, so this is exactly `MainFacetCapabilities`,
 * the type the host installs. `test/facet/loader-environment.test.ts` checks that the two agree,
 * which is what keeps a per-project capability from acquiring a slot here.
 */
export type Generation0Capabilities = Readonly<{
  MODEL: ModelCapability;
}>;
