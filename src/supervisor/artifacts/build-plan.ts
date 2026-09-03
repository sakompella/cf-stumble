import { Result } from "better-result";
import { MainHarnessArtifact } from "../../facet/index.js";
import type { MainHarnessArtifactInput, MainHarnessArtifactProblem } from "../../facet/index.js";
import type { HarnessCommit } from "../../harness-commit.js";
import type { HarnessBuildStepName } from "../../harness-build.js";
import { canonicalModuleMap } from "./module-map.js";

/**
 * The build plan itself belongs to the workspace that runs it, so the Supervisor and the Workspace
 * Host plan one labeled commit the same way. This module keeps only what the Supervisor adds:
 * the build's output shape, its failures, and validation of what a build produced.
 */
export {
  HARNESS_BUILD_CONFIGURATION,
  planHarnessBuild,
  type HarnessBuildConfiguration,
  type HarnessBuildPlan,
  type HarnessBuildStep,
  type HarnessBuildStepName,
} from "../../harness-build.js";

/** What a build writes to `moduleMapPath`. The build never states its own commit. */
export type BuiltModuleMapFile = Readonly<{
  entryModule: string;
  modules: readonly Readonly<{ name: string; source: string }>[];
}>;

export type HarnessBuildProblem =
  | { readonly code: "build-workspace-unavailable"; readonly harnessCommit: string }
  | {
      readonly code: "build-step-failed";
      readonly harnessCommit: string;
      readonly step: HarnessBuildStepName;
      readonly exitCode: number;
    }
  | { readonly code: "build-output-missing"; readonly harnessCommit: string }
  | {
      readonly code: "build-output-invalid";
      readonly harnessCommit: string;
      readonly reason: MainHarnessArtifactProblem["code"];
    };

/**
 * Validate the build's own output and give it the commit identity the Supervisor asked to build.
 * A build cannot claim to be another generation, because the commit comes from the caller.
 */
export function moduleMapFromBuildOutput(
  harnessCommit: HarnessCommit,
  output: BuiltModuleMapFile,
): Result<MainHarnessArtifactInput, HarnessBuildProblem> {
  // The build wrote this file, so the declared type describes what JSON decoding produced, not a
  // checked value. This guard keeps a non-object from throwing, and `MainHarnessArtifact.parse`
  // checks every field that can reach a module map.
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Boundary: decoded build output is untrusted.
  if (output === null || typeof output !== "object") {
    return Result.err({ code: "build-output-invalid", harnessCommit, reason: "invalid-artifact" });
  }

  const parsed = MainHarnessArtifact.parse({
    harnessCommit,
    entryModule: output.entryModule,
    modules: output.modules,
  });
  if (parsed.isErr()) {
    return Result.err({ code: "build-output-invalid", harnessCommit, reason: parsed.error.code });
  }

  return Result.ok(canonicalModuleMap(parsed.value));
}
