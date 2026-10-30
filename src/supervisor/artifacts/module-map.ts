import type { MainHarnessArtifact, MainHarnessArtifactInput } from "../../facet/index.js";

/** Commit, entry module, then modules sorted by name, so a build that reports modules in another order yields the same rows. */
export function canonicalModuleMap(artifact: MainHarnessArtifact): MainHarnessArtifactInput {
  return {
    harnessCommit: artifact.harnessCommit,
    entryModule: artifact.modules[0].name,
    modules: artifact.modules
      .map((module) => ({ name: module.name, source: module.source }))
      .toSorted(byModuleName),
  };
}

export function encodeModuleMap(moduleMap: MainHarnessArtifactInput): string {
  return JSON.stringify({
    harnessCommit: moduleMap.harnessCommit,
    entryModule: moduleMap.entryModule,
    modules: moduleMap.modules.map((module) => ({ name: module.name, source: module.source })),
  });
}

function byModuleName(
  left: MainHarnessArtifactInput["modules"][number],
  right: MainHarnessArtifactInput["modules"][number],
): number {
  if (left.name === right.name) {
    return 0;
  }

  return left.name < right.name ? -1 : 1;
}
