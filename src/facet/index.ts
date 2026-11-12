import type { ModelRoute } from "../model-route.js";
import type { StartupCheckModel } from "../startup-check-model.js";
import type { HarnessModule, MainHarnessArtifact } from "./artifact.js";
import type { ConversationFacet } from "./conversation-protocol.js";
import { FACET_RUNTIME } from "./runtime-contract.js";

export {
  ModuleMapSchema,
  parseMainHarnessArtifact,
  parseMainHarnessArtifactJson,
} from "./artifact.js";

export { FACET_COMPATIBILITY } from "./runtime-contract.js";

export type { HarnessModule, MainHarnessArtifact, MainHarnessArtifactProblem } from "./artifact.js";

export type { EntriesRequest } from "../entries-request.js";

export type MainFacetTarget = Rpc.DurableObjectBranded & ConversationFacet;

function workerModuleEntry(module: HarnessModule): [string, WorkerLoaderModule] {
  return [module.name, { js: module.source }];
}

export type MainFacetModel = Fetcher<ModelRoute> | Fetcher<StartupCheckModel>;

export function mainFacetCode(artifact: MainHarnessArtifact): WorkerLoaderWorkerCode {
  return {
    ...FACET_RUNTIME,
    mainModule: artifact.modules[0].name,
    modules: Object.fromEntries(artifact.modules.map(workerModuleEntry)),
    globalOutbound: null,
  };
}

export function loadMainFacet(loader: WorkerLoader, artifact: MainHarnessArtifact) {
  const worker = loader.get(artifact.harnessCommit, () => mainFacetCode(artifact));

  return { worker, facetClass: worker.getDurableObjectClass<MainFacetTarget>("MainFacet") };
}

export type {
  ConversationHost,
  FacetLogFields,
  FacetLogLevel,
  RunFailures,
  RunningConversation,
} from "./conversation-protocol.js";
