import * as Result from "effect/Result";
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
 * The Supervisor holds a stub of this shape and nothing wider. `startTurn` takes the project capability
 * as an argument because loader environments are cached per harness commit and shared by every project.
 * `workingDirectory` is separate from `request` because the host decides it and a client must not
 * present one.
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

/** Loader entries are cached per harness commit, so only generation-invariant capabilities belong here; per-project ones arrive as `startTurn` arguments. */
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
