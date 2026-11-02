import type { ModelRoute } from "../model-route.js";
import type { HarnessModule, MainHarnessArtifact } from "./artifact.js";
import type { ConversationFacet } from "./conversation-protocol.js";

export { MainHarnessArtifact } from "./artifact.js";

export type { HarnessModule, MainHarnessArtifactProblem } from "./artifact.js";

export type MainFacetTarget = Rpc.DurableObjectBranded & ConversationFacet;

function workerModuleEntry(module: HarnessModule): [string, WorkerLoaderModule] {
  return [module.name, { js: module.source }];
}

export type MainFacetCapabilities = Readonly<{
  MODEL: Fetcher<ModelRoute>;
}>;

export function loadMainFacet(
  loader: WorkerLoader,
  artifact: MainHarnessArtifact,
  capabilities: MainFacetCapabilities,
) {
  const worker = loader.get(artifact.harnessCommit, () => ({
    compatibilityDate: "2025-01-01",
    compatibilityFlags: ["enable_weak_ref"],
    mainModule: artifact.modules[0].name,
    modules: Object.fromEntries(artifact.modules.map(workerModuleEntry)),
    env: capabilities,
    globalOutbound: null,
  }));

  return { worker, facetClass: worker.getDurableObjectClass<MainFacetTarget>("MainFacet") };
}

export type { ConversationHost, GenerationHost } from "./conversation-protocol.js";
