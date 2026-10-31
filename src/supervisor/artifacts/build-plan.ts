import * as Result from "effect/Result";
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

export type BuiltModuleMapFile = Readonly<{
  entryModule: string;
  modules: readonly Readonly<{ name: string; source: string }>[];
}>;

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
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Boundary: decoded build output is untrusted.
  if (output === null || typeof output !== "object") {
    return Result.fail({ code: "build-output-invalid", harnessCommit, reason: "invalid-artifact" });
  }

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
