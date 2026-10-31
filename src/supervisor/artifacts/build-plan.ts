import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { MainHarnessArtifact } from "../../facet/index.js";
import type { MainHarnessArtifactInput, MainHarnessArtifactProblem } from "../../facet/index.js";
import type { HarnessCommit } from "../../harness-commit.js";
import type { HarnessBuildStepName } from "../../harness-build.js";
import { canonicalModuleMap } from "./module-map.js";

export {
  HARNESS_BUILD_CONFIGURATION,
  planHarnessBuild,
  type HarnessBuildConfiguration,
  type HarnessBuildPlan,
  type HarnessBuildStep,
  type HarnessBuildStepName,
} from "../../harness-build.js";

export const BuiltModuleMapFile = Schema.Struct({
  entryModule: Schema.String,
  modules: Schema.Array(Schema.Struct({ name: Schema.String, source: Schema.String })),
});

export type BuiltModuleMapFile = typeof BuiltModuleMapFile.Type;

export type BuildStepDiagnostics = Readonly<{
  stdoutTail: string;
  stderrTail: string;
  truncated: boolean;
}>;

export type HarnessBuildProblem =
  | { readonly code: "build-workspace-unavailable"; readonly harnessCommit: string }
  | {
      readonly code: "build-step-failed";
      readonly harnessCommit: string;
      readonly step: HarnessBuildStepName;
      readonly exitCode: number;
      readonly diagnostics: BuildStepDiagnostics;
    }
  | { readonly code: "build-output-missing"; readonly harnessCommit: string }
  | {
      readonly code: "build-output-invalid";
      readonly harnessCommit: string;
      readonly reason: MainHarnessArtifactProblem["code"];
    };

export function moduleMapFromBuildOutput(
  harnessCommit: HarnessCommit,
  output: BuiltModuleMapFile,
): Result.Result<MainHarnessArtifactInput, HarnessBuildProblem> {
  const parsed = MainHarnessArtifact.parse({
    harnessCommit,
    entryModule: output.entryModule,
    modules: output.modules,
  });

  if (Result.isFailure(parsed)) {
    return Result.fail({
      code: "build-output-invalid",
      harnessCommit,
      reason: parsed.failure.code,
    });
  }

  return Result.succeed(canonicalModuleMap(parsed.success));
}
