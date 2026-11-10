import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { isHarnessCommit, type HarnessCommit } from "../harness-commit.js";

export type HarnessModule = { readonly name: string; readonly source: string };

const HarnessModuleSchema = Schema.Struct({ name: Schema.String, source: Schema.String });

export const ModuleMapSchema = Schema.Struct({
  entryModule: Schema.String,
  modules: Schema.Array(HarnessModuleSchema),
});

const HarnessCommitText = Schema.String.pipe(
  Schema.refine((value): value is HarnessCommit => isHarnessCommit(value)),
);

const ArtifactInputSchema = Schema.Struct({
  harnessCommit: Schema.String,
  entryModule: Schema.String,
  modules: Schema.Array(HarnessModuleSchema),
});

export type MainHarnessArtifactInput = typeof ArtifactInputSchema.Type;

const CheckedModuleMap = ModuleMapSchema.check(
  Schema.makeFilter((input) => {
    if (input.modules.length === 0) return "empty-module-map";

    const names = input.modules.map((module) => module.name);
    const repeated = names.find((name, index) => names.indexOf(name) !== index);

    if (repeated !== undefined) return `duplicate-module-name ${repeated}`;

    if (!names.includes(input.entryModule)) {
      return `entry-module-not-found ${input.entryModule}`;
    }

    return true;
  }),
);

const decodeCheckedModuleMap = Schema.decodeResult(CheckedModuleMap);

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

export type MainHarnessArtifact = Readonly<{
  harnessCommit: HarnessCommit;
  modules: readonly [entryModule: HarnessModule, ...otherModules: HarnessModule[]];
}>;

function moduleMapProblem(message: string): MainHarnessArtifactProblem {
  const space = message.indexOf(" ");
  const code = space === -1 ? message : message.slice(0, space);
  const detail = space === -1 ? "" : message.slice(space + 1);

  switch (code) {
    case "empty-module-map":
      return { code: "empty-module-map" };
    case "duplicate-module-name":
      return { code: "duplicate-module-name", moduleName: detail };
    case "entry-module-not-found":
      return { code: "entry-module-not-found", entryModule: detail };
    default:
      return { code: "invalid-artifact" };
  }
}

function entryFirst(
  entryModule: string,
  modules: readonly HarnessModule[],
): Result.Result<readonly [HarnessModule, ...HarnessModule[]], MainHarnessArtifactProblem> {
  const others: HarnessModule[] = [];
  let entry: HarnessModule | undefined;

  for (const module of modules) {
    if (module.name === entryModule) {
      entry = module;
    } else {
      others.push(module);
    }
  }

  return entry === undefined
    ? Result.fail({ code: "entry-module-not-found", entryModule })
    : Result.succeed([entry, ...others]);
}

export function parseMainHarnessArtifact(
  input: MainHarnessArtifactInput,
): Result.Result<MainHarnessArtifact, MainHarnessArtifactProblem> {
  return Result.gen(function* () {
    const moduleMap = yield* Result.mapError(
      decodeCheckedModuleMap({ entryModule: input.entryModule, modules: input.modules }),
      (failure) => moduleMapProblem(failure.message),
    );

    const harnessCommit = yield* Result.mapError(
      Schema.decodeResult(HarnessCommitText)(input.harnessCommit),
      (): MainHarnessArtifactProblem => ({
        code: "invalid-harness-commit",
        harnessCommit: input.harnessCommit,
      }),
    );

    const modules = yield* entryFirst(input.entryModule, moduleMap.modules);

    return { harnessCommit, modules };
  });
}

export function parseMainHarnessArtifactJson(
  text: string,
): Result.Result<MainHarnessArtifact, MainHarnessArtifactProblem> {
  const input = decodeArtifactJson(text);

  return Result.isFailure(input)
    ? Result.fail({ code: "invalid-artifact" })
    : parseMainHarnessArtifact(input.success);
}
