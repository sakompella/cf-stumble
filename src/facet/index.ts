/// <reference types="@cloudflare/workers-types" />

import { Result } from "better-result";
import { MainHarnessArtifact } from "./artifact.js";
import { fixtureMainHarnessArtifact } from "./fixture.js";
import type {
  HarnessModule,
  MainHarnessArtifactInput,
  MainHarnessArtifactProblem,
} from "./artifact.js";

export { MainHarnessArtifact } from "./artifact.js";
export type { MainHarnessArtifactInput, MainHarnessArtifactProblem } from "./artifact.js";
export { fixtureMainHarnessArtifact, fixtureMainHarnessCommit } from "./fixture.js";

function workerModuleEntry(module: HarnessModule): [string, WorkerLoaderModule] {
  return [module.name, { js: module.source }];
}

function loadArtifact(loader: WorkerLoader, artifact: MainHarnessArtifact): WorkerStub {
  return loader.get(artifact.harnessCommit, () => ({
    compatibilityDate: "2025-01-01",
    mainModule: artifact.modules[0].name,
    modules: Object.fromEntries(artifact.modules.map(workerModuleEntry)),
    env: {},
    globalOutbound: null,
  }));
}

export function loadMainFacet(
  loader: WorkerLoader,
  input: MainHarnessArtifactInput,
): Result<
  { readonly worker: WorkerStub; readonly facetClass: DurableObjectClass },
  MainHarnessArtifactProblem
> {
  const artifact = MainHarnessArtifact.parse(input);
  if (artifact.isErr()) {
    return Result.err(artifact.error);
  }

  const worker = loadArtifact(loader, artifact.value);

  return Result.ok({ worker, facetClass: worker.getDurableObjectClass("MainFacet") });
}

export function loadFixtureMainFacet(
  loader: WorkerLoader,
): Result<
  { readonly worker: WorkerStub; readonly facetClass: DurableObjectClass },
  MainHarnessArtifactProblem
> {
  return loadMainFacet(loader, fixtureMainHarnessArtifact);
}
