/// <reference types="@cloudflare/workers-types" />

import { Result } from "better-result";
import { MainHarnessArtifact } from "./artifact.js";
import type { ModelRoute } from "../model-route.js";
import type { WorkspaceCapability } from "./generation-0/index.js";
import type {
  HarnessModule,
  MainHarnessArtifactInput,
  MainHarnessArtifactProblem,
} from "./artifact.js";

export { MainHarnessArtifact } from "./artifact.js";
export type { MainHarnessArtifactInput, MainHarnessArtifactProblem } from "./artifact.js";
export type { WorkspaceCapability } from "./generation-0/index.js";

function workerModuleEntry(module: HarnessModule): [string, WorkerLoaderModule] {
  return [module.name, { js: module.source }];
}

/**
 * What a main-facet generation receives. These are capabilities, not bindings: the model route
 * keeps the model choice and the credential outside the facet, and the workspace capability
 * returns plain results rather than a Computer workspace or its container API.
 *
 * `WORKSPACE` is optional while the concrete Computer adapter is wired separately. A generation
 * that receives no workspace still starts and still answers `GET /`.
 */
export type MainFacetCapabilities = Readonly<{
  MODEL: Fetcher<ModelRoute>;
  WORKSPACE?: WorkspaceCapability;
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
  { readonly worker: WorkerStub; readonly facetClass: DurableObjectClass },
  MainHarnessArtifactProblem
> {
  const artifact = MainHarnessArtifact.parse(input);
  if (artifact.isErr()) {
    return Result.err(artifact.error);
  }

  const worker = loadArtifact(loader, artifact.value, capabilities);

  return Result.ok({ worker, facetClass: worker.getDurableObjectClass("MainFacet") });
}
