/// <reference types="@cloudflare/workers-types" />

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

export type MainHarnessArtifactValidation =
  | {
      readonly ok: true;
      readonly artifact: MainHarnessArtifact;
    }
  | {
      readonly ok: false;
      readonly problem: MainHarnessArtifactProblem;
    };

type ModuleMapProblem = Exclude<
  MainHarnessArtifactProblem,
  { readonly code: "invalid-harness-commit" }
>;

type ModuleMapValidation =
  | {
      readonly ok: true;
      readonly modules: readonly [entryModule: HarnessModule, ...otherModules: HarnessModule[]];
    }
  | {
      readonly ok: false;
      readonly problem: ModuleMapProblem;
    };

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

  static parse(input: MainHarnessArtifactInput): MainHarnessArtifactValidation {
    const moduleMap = parseModuleMap(input.entryModule, input.modules);
    if (!moduleMap.ok) {
      return moduleMap;
    }

    const harnessCommit = parseHarnessCommit(input.harnessCommit);
    if (harnessCommit === undefined) {
      return {
        ok: false,
        problem: {
          code: "invalid-harness-commit",
          harnessCommit: input.harnessCommit,
        },
      };
    }

    return {
      ok: true,
      artifact: new MainHarnessArtifact(harnessCommit, moduleMap.modules),
    };
  }
}

function parseModuleMap(
  entryModuleName: string,
  modules: MainHarnessArtifactInput["modules"],
): ModuleMapValidation {
  if (modules.length === 0) {
    return { ok: false, problem: { code: "empty-module-map" } };
  }

  const moduleNames = new Set<string>();
  const otherModules: HarnessModule[] = [];
  let entryModule: HarnessModule | undefined;

  for (const module of modules) {
    if (moduleNames.has(module.name)) {
      return {
        ok: false,
        problem: {
          code: "duplicate-module-name",
          moduleName: module.name,
        },
      };
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
    return {
      ok: false,
      problem: {
        code: "entry-module-not-found",
        entryModule: entryModuleName,
      },
    };
  }

  return { ok: true, modules: [entryModule, ...otherModules] };
}
