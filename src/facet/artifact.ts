/// <reference types="@cloudflare/workers-types" />

import { Result } from "better-result";
import { parseHarnessCommit, type HarnessCommit } from "../harness-commit.js";

export type HarnessModule = {
  readonly name: string;
  readonly source: string;
};

export type MainHarnessArtifactInput = {
  readonly harnessCommit: string;
  readonly entryModule: string;
  readonly modules: readonly {
    readonly name: string;
    readonly source: string;
  }[];
};

export type MainHarnessArtifactProblem =
  | {
      readonly code: "invalid-harness-commit";
      readonly harnessCommit: string;
    }
  | { readonly code: "empty-module-map" }
  | {
      readonly code: "entry-module-not-found";
      readonly entryModule: string;
    }
  | {
      readonly code: "duplicate-module-name";
      readonly moduleName: string;
    };

type ModuleMapProblem = Exclude<
  MainHarnessArtifactProblem,
  { readonly code: "invalid-harness-commit" }
>;

export class MainHarnessArtifact {
  readonly harnessCommit: HarnessCommit;
  readonly modules: readonly [entryModule: HarnessModule, ...otherModules: HarnessModule[]];

  private constructor(
    harnessCommit: HarnessCommit,
    modules: readonly [entryModule: HarnessModule, ...otherModules: HarnessModule[]],
  ) {
    this.harnessCommit = harnessCommit;
    this.modules = modules;
  }

  static parse(
    input: MainHarnessArtifactInput,
  ): Result<MainHarnessArtifact, MainHarnessArtifactProblem> {
    const moduleMap = parseModuleMap(input.entryModule, input.modules);
    if (moduleMap.isErr()) {
      return Result.err(moduleMap.error);
    }

    const harnessCommit = parseHarnessCommit(input.harnessCommit);
    if (harnessCommit === undefined) {
      return Result.err({
        code: "invalid-harness-commit",
        harnessCommit: input.harnessCommit,
      });
    }

    return Result.ok(new MainHarnessArtifact(harnessCommit, moduleMap.value));
  }
}

function parseModuleMap(
  entryModuleName: string,
  modules: MainHarnessArtifactInput["modules"],
): Result<
  readonly [entryModule: HarnessModule, ...otherModules: HarnessModule[]],
  ModuleMapProblem
> {
  if (modules.length === 0) {
    return Result.err({ code: "empty-module-map" });
  }

  const moduleNames = new Set<string>();
  const otherModules: HarnessModule[] = [];
  let entryModule: HarnessModule | undefined;

  for (const module of modules) {
    if (moduleNames.has(module.name)) {
      return Result.err({
        code: "duplicate-module-name",
        moduleName: module.name,
      });
    }

    moduleNames.add(module.name);
    const harnessModule = { name: module.name, source: module.source };

    if (module.name === entryModuleName) {
      entryModule = harnessModule;
    } else {
      otherModules.push(harnessModule);
    }
  }

  if (entryModule === undefined) {
    return Result.err({
      code: "entry-module-not-found",
      entryModule: entryModuleName,
    });
  }

  return Result.ok([entryModule, ...otherModules]);
}
