import type { HarnessModule, MainHarnessArtifact } from "../../facet/index.js";

export function encodeModuleMap(artifact: MainHarnessArtifact): string {
  return JSON.stringify({
    harnessCommit: artifact.harnessCommit,
    entryModule: artifact.modules[0].name,
    modules: artifact.modules
      .map((module) => ({ name: module.name, source: module.source }))
      .toSorted(byModuleName),
  });
}

function byModuleName(left: HarnessModule, right: HarnessModule): number {
  if (left.name === right.name) {
    return 0;
  }

  return left.name < right.name ? -1 : 1;
}
