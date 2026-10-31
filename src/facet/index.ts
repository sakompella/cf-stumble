import * as Result from "effect/Result";
import { MainHarnessArtifact } from "./artifact.js";
import type { ModelRoute } from "../model-route.js";
import type { ConversationFacet } from "./conversation-protocol.js";
import type {
  HarnessModule,
  MainHarnessArtifactInput,
  MainHarnessArtifactProblem,
} from "./artifact.js";

export { MainHarnessArtifact } from "./artifact.js";

export type { MainHarnessArtifactInput, MainHarnessArtifactProblem } from "./artifact.js";

export interface MainFacetTarget extends Rpc.DurableObjectBranded, ConversationFacet {
  fetch(request: Request): Promise<Response>;
}

function workerModuleEntry(module: HarnessModule): [string, WorkerLoaderModule] {
  return [module.name, { js: module.source }];
}

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
    compatibilityFlags: ["enable_weak_ref"],
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
): Result.Result<
  {
    readonly worker: WorkerStub;
    readonly facetClass: DurableObjectClass<MainFacetTarget>;
  },
  MainHarnessArtifactProblem
> {
  return MainHarnessArtifact.parse(input).pipe(
    Result.map((artifact) => {
      const worker = loadArtifact(loader, artifact, capabilities);

      return { worker, facetClass: worker.getDurableObjectClass<MainFacetTarget>("MainFacet") };
    }),
  );
}

export type { ConversationHost } from "./conversation-protocol.js";
