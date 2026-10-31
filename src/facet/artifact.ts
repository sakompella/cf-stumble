import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { parseHarnessCommit, type HarnessCommit } from "../harness-commit.js";

export type HarnessModule = {
  readonly name: string;
  readonly source: string;
};

const ArtifactInputSchema = Schema.Struct({
  harnessCommit: Schema.String,
  entryModule: Schema.String,
  modules: Schema.Array(Schema.Struct({ name: Schema.String, source: Schema.String })),
});

export type MainHarnessArtifactInput = typeof ArtifactInputSchema.Type;

const decodeArtifactJson = Schema.decodeUnknownResult(Schema.fromJsonString(ArtifactInputSchema));

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

  static parseJson(text: string): Result.Result<MainHarnessArtifact, MainHarnessArtifactProblem> {
    const input = decodeArtifactJson(text);

    return Result.isFailure(input)
      ? Result.fail({ code: "invalid-artifact" })
      : MainHarnessArtifact.parse(input.success);
  }

  static parse(
    input: MainHarnessArtifactInput,
  ): Result.Result<MainHarnessArtifact, MainHarnessArtifactProblem> {
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
