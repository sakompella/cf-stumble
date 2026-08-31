/// <reference types="@cloudflare/workers-types" />

import { MainHarnessArtifact } from "./artifact.js";
import { fixtureMainHarnessArtifact } from "./fixture.js";
import type {
  HarnessModule,
  MainHarnessArtifactInput,
  MainHarnessArtifactProblem,
} from "./artifact.js";

export { MainHarnessArtifact } from "./artifact.js";
export type {
  MainHarnessArtifactInput,
  MainHarnessArtifactProblem,
  MainHarnessArtifactValidation,
} from "./artifact.js";
export { fixtureMainHarnessArtifact, fixtureMainHarnessCommit } from "./fixture.js";

export type MainFacetLoadResult =
  | {
      readonly ok: true;
      readonly worker: WorkerStub;
      readonly facetClass: DurableObjectClass;
    }
  | {
      readonly ok: false;
      readonly problem: MainHarnessArtifactProblem;
    };

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
): MainFacetLoadResult {
  const artifact = MainHarnessArtifact.parse(input);
  if (!artifact.ok) {
    return artifact;
  }

  const worker = loadArtifact(loader, artifact.artifact);

  return { ok: true, worker, facetClass: worker.getDurableObjectClass("MainFacet") };
}

export function loadFixtureMainFacet(loader: WorkerLoader): MainFacetLoadResult {
  return loadMainFacet(loader, fixtureMainHarnessArtifact);
}
