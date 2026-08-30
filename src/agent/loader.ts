/// <reference types="@cloudflare/workers-types" />

class HarnessCommitId {
  readonly value: string;

  private constructor(value: string) {
    this.value = value;
  }

  static parse(value: string): HarnessCommitId | undefined {
    return /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(value) ? new HarnessCommitId(value) : undefined;
  }
}

type HarnessModule = {
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
  readonly harnessCommit: HarnessCommitId;
  readonly modules: readonly [entryModule: HarnessModule, ...otherModules: HarnessModule[]];

  private constructor(
    harnessCommit: HarnessCommitId,
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

    const harnessCommit = HarnessCommitId.parse(input.harnessCommit);
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

const fixtureMainFacetArtifact: MainHarnessArtifactInput = {
  harnessCommit: "f53a0e1c1bdbe213ab700a84b1db23615cc24b00",
  entryModule: "main-facet.js",
  modules: [
    {
      name: "main-facet.js",
      source: `
import { DurableObject } from "cloudflare:workers";
import { pingResponse } from "./ping.js";

export class MainFacet extends DurableObject {
  fetch(request) {
    if (new URL(request.url).pathname === "/facet/ping") {
      return pingResponse();
    }

    return new Response("Not found", { status: 404 });
  }
}
`,
    },
    {
      name: "ping.js",
      source: `export function pingResponse() {
  return new Response("pong");
}
`,
    },
  ],
};

function workerModuleEntry(module: HarnessModule): [string, WorkerLoaderModule] {
  return [module.name, { js: module.source }];
}

function loadArtifact(loader: WorkerLoader, artifact: MainHarnessArtifact): WorkerStub {
  return loader.get(artifact.harnessCommit.value, () => ({
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
  return loadMainFacet(loader, fixtureMainFacetArtifact);
}
