/// <reference types="@cloudflare/workers-types" />

import { Result } from "better-result";
import { MainHarnessArtifact } from "./artifact.js";
import type { ModelRoute } from "../model-route.js";
import type { ProjectRpcTargetContract } from "../workspace/project/protocol.js";
import type {
  HarnessModule,
  MainHarnessArtifactInput,
  MainHarnessArtifactProblem,
} from "./artifact.js";

export { MainHarnessArtifact } from "./artifact.js";
export type { MainHarnessArtifactInput, MainHarnessArtifactProblem } from "./artifact.js";

/**
 * What every main-harness generation must expose, whatever else it adds. The Supervisor holds a
 * stub of this shape and nothing wider, so a generation cannot widen the surface the host talks
 * to by adding methods.
 *
 * `startTurn` takes the project capability as an argument. That is the whole reason this contract
 * has a method rather than only `fetch`: a capability belonging to one project must not reach
 * loader environment, which is cached per harness commit and shared by every project the
 * generation serves.
 *
 * `workingDirectory` is an argument of its own rather than a field of `request` because the host
 * decides it and a client must not be able to present one. The host resolves the selected project
 * against its catalog and passes that project's directory in the shared workspace (ADR-0038); the
 * request beside it is the untrusted half.
 */
export interface MainFacetTarget extends Rpc.DurableObjectBranded {
  fetch(request: Request): Promise<Response>;
  startTurn(
    projectTarget: ProjectRpcTargetContract,
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Boundary: the turn request crosses an RPC hop into generated code, so the host proves nothing about its shape and the generation parses it.
    request: unknown,
    workingDirectory: string,
  ): ReadableStream<Uint8Array>;
}

function workerModuleEntry(module: HarnessModule): [string, WorkerLoaderModule] {
  return [module.name, { js: module.source }];
}

/**
 * What a main-facet generation receives in its loader environment. These are capabilities, not
 * bindings: the model route keeps the model choice, the reasoning effort, the endpoint, and the
 * credential outside the facet.
 *
 * Only generation-invariant capabilities belong here. The Worker Loader caches an entry under the
 * harness commit, so anything placed here outlives the request that installed it and is shared by
 * every request that generation serves; a capability scoped to one project would be whichever
 * project warmed the cache. Those arrive as arguments of {@link MainFacetTarget.startTurn}
 * instead.
 */
export type MainFacetCapabilities = Readonly<{
  MODEL: Fetcher<ModelRoute>;
}>;

function loadArtifact(
  loader: WorkerLoader,
  artifact: MainHarnessArtifact,
  capabilities: MainFacetCapabilities,
): WorkerStub {
  return loader.get(artifact.harnessCommit, () => ({
    compatibilityDate: "2025-01-01",
    mainModule: artifact.modules[0].name,
    modules: Object.fromEntries(artifact.modules.map(workerModuleEntry)),
    env: capabilities,
    globalOutbound: null,
  }));
}

export function loadMainFacet(
  loader: WorkerLoader,
  input: MainHarnessArtifactInput,
  capabilities: MainFacetCapabilities,
): Result<
  {
    readonly worker: WorkerStub;
    readonly facetClass: DurableObjectClass<MainFacetTarget>;
  },
  MainHarnessArtifactProblem
> {
  const artifact = MainHarnessArtifact.parse(input);
  if (artifact.isErr()) {
    return Result.err(artifact.error);
  }

  const worker = loadArtifact(loader, artifact.value, capabilities);

  return Result.ok({
    worker,
    facetClass: worker.getDurableObjectClass<MainFacetTarget>("MainFacet"),
  });
}
