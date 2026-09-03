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
 * The workspace capability the host hands a Generation 0 facet. It is the Workspace Host's own RPC
 * surface, so this generation reuses that contract instead of describing a second one, and it
 * receives plain results rather than a Computer workspace, a container API, or a binding.
 */
export type WorkspaceCapability = Readonly<{
  execute(request: WorkspaceRequest): Promise<WorkspaceResult>;
}>;

/**
 * Everything a Generation 0 facet may use. It holds capabilities only. There is no raw binding, no
 * credential, no model name, no reasoning level, and no session store: the saved document arrives
 * with the turn request and leaves with the turn response.
 *
 * `WORKSPACE` is optional because the concrete Computer adapter is wired separately. A turn that
 * needs files or a command without it reports a tool error rather than failing the facet.
 */
export type Generation0Capabilities = Readonly<{
  MODEL: ModelCapability;
  WORKSPACE?: WorkspaceCapability;
}>;
