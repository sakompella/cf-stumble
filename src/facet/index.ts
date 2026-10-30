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

/**
 * The Supervisor holds a stub of this shape and nothing wider. Project capabilities arrive through
 * the attached host, never through the loader environment, because loader environments are cached
 * per harness commit and shared by every project.
 */
export interface MainFacetTarget extends Rpc.DurableObjectBranded, ConversationFacet {
  fetch(request: Request): Promise<Response>;
}

function workerModuleEntry(module: HarnessModule): [string, WorkerLoaderModule] {
  return [module.name, { js: module.source }];
}

/** Loader entries are cached per harness commit, so only generation-invariant capabilities belong here. */
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
    // Chord, under Pi Durable, uses WeakRef, which this date does not enable by itself.
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
