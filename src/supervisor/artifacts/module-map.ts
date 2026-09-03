import type { MainHarnessArtifact, MainHarnessArtifactInput } from "../../facet/index.js";

/**
 * One canonical encoding of a module map: the harness commit, the entry module name, then every
 * module sorted by name. ADR-0034 assumes that two builds of one labeled commit describe the same
 * code, and this form is what makes that assumption checkable, because a build that reports its
 * modules in another order still produces the same bytes. The canonical form is not a second
 * artifact identity; ADR-0027 keeps the labeled harness commit as the only one.
 */
export function canonicalModuleMap(artifact: MainHarnessArtifact): MainHarnessArtifactInput {
  return {
    harnessCommit: artifact.harnessCommit,
    entryModule: artifact.modules[0].name,
    modules: artifact.modules
      .map((module) => ({ name: module.name, source: module.source }))
      .toSorted(byModuleName),
  };
}

/** The exact bytes a canonical module map occupies in the R2 cache. */
export function encodeModuleMap(moduleMap: MainHarnessArtifactInput): string {
  return JSON.stringify({
    harnessCommit: moduleMap.harnessCommit,
    entryModule: moduleMap.entryModule,
    modules: moduleMap.modules.map((module) => ({ name: module.name, source: module.source })),
  });
}

/** Compare two canonical module maps. Both sides must already come from `canonicalModuleMap`. */
export function sameModuleMap(
  left: MainHarnessArtifactInput,
  right: MainHarnessArtifactInput,
): boolean {
  return encodeModuleMap(left) === encodeModuleMap(right);
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
