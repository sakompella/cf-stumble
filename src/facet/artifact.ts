import * as Result from "effect/Result";
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
  | { readonly code: "invalid-artifact" }
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

  /**
   * A module map reaches this class as decoded JSON: a build wrote it, or a stored artifact
   * decoded to it. Nothing before this point proved its shape, so the parameter says so and
   * `isMainHarnessArtifactInput` is what turns it into the declared input type.
   */
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Boundary: a built or stored module map is decoded JSON, so its shape is proven here.
  static parse(input: unknown): Result.Result<MainHarnessArtifact, MainHarnessArtifactProblem> {
    if (!isMainHarnessArtifactInput(input)) {
      return Result.fail({ code: "invalid-artifact" });
    }

    const moduleMap = parseModuleMap(input.entryModule, input.modules);

    if (Result.isFailure(moduleMap)) {
      return Result.fail(moduleMap.failure);
    }

    const harnessCommit = parseHarnessCommit(input.harnessCommit);

    if (harnessCommit === undefined) {
      return Result.fail({
        code: "invalid-harness-commit",
        harnessCommit: input.harnessCommit,
      });
    }

    return Result.succeed(new MainHarnessArtifact(harnessCommit, moduleMap.success));
  }
}

function isHarnessModuleInput(
  value: unknown,
): value is MainHarnessArtifactInput["modules"][number] {
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    typeof value.name === "string" &&
    "source" in value &&
    typeof value.source === "string"
  );
}

/** The one place a decoded module map becomes a `MainHarnessArtifactInput`. */
function isMainHarnessArtifactInput(value: unknown): value is MainHarnessArtifactInput {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  if (!("harnessCommit" in value) || typeof value.harnessCommit !== "string") {
    return false;
  }

  if (!("entryModule" in value) || typeof value.entryModule !== "string") {
    return false;
  }

  if (!("modules" in value)) {
    return false;
  }

  const modules: unknown = value.modules;

  return Array.isArray(modules) && modules.every((module) => isHarnessModuleInput(module));
}

function parseModuleMap(
  entryModuleName: string,
  modules: MainHarnessArtifactInput["modules"],
): Result.Result<
  readonly [entryModule: HarnessModule, ...otherModules: HarnessModule[]],
  ModuleMapProblem
> {
  if (modules.length === 0) {
    return Result.fail({ code: "empty-module-map" });
  }

  const moduleNames = new Set<string>();
  const otherModules: HarnessModule[] = [];
  let entryModule: HarnessModule | undefined;

  for (const module of modules) {
    if (moduleNames.has(module.name)) {
      return Result.fail({
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
    return Result.fail({
      code: "entry-module-not-found",
      entryModule: entryModuleName,
    });
  }

  return Result.succeed([entryModule, ...otherModules]);
}
