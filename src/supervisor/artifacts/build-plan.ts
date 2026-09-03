import { Result } from "better-result";
import { MainHarnessArtifact } from "../../facet/index.js";
import type { MainHarnessArtifactInput, MainHarnessArtifactProblem } from "../../facet/index.js";
import type { HarnessCommit } from "../../harness-commit.js";
import { canonicalModuleMap } from "./module-map.js";

/**
 * Where and how one labeled harness commit becomes a module map. Version 0 has one build path, so
 * these values are fixed by whoever wires the build workspace rather than chosen per request.
 * `buildRoot` must not be the project workspace root: a build must not see or touch project files.
 */
export type HarnessBuildConfiguration = Readonly<{
  buildRoot: string;
  harnessGitDir: string;
  buildCommand: string;
  moduleMapPath: string;
}>;

export type HarnessBuildStepName = "isolate" | "checkout" | "build";

export type HarnessBuildStep = Readonly<{
  name: HarnessBuildStepName;
  source: string;
  cwd: string;
}>;

export type HarnessBuildPlan = Readonly<{
  directory: string;
  steps: readonly [HarnessBuildStep, ...HarnessBuildStep[]];
  moduleMapPath: string;
}>;

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
 * Plan the whole build as plain command strings. `git archive` extracts the commit's tree into a
 * directory of its own, so no step mutates a shared working tree and a repeated build of one
 * commit starts from the same files. Interpolating the commit is safe because `HarnessCommit`
 * accepts only lower-case hexadecimal object IDs.
 */
export function planHarnessBuild(
  configuration: HarnessBuildConfiguration,
  harnessCommit: HarnessCommit,
): HarnessBuildPlan {
  const directory = `${configuration.buildRoot}/${harnessCommit}`;
  return {
    directory,
    steps: [
      { name: "isolate", source: `rm -rf ${directory} && mkdir -p ${directory}`, cwd: "/" },
      {
        name: "checkout",
        source: `git --git-dir=${configuration.harnessGitDir} archive ${harnessCommit} | tar -x -C ${directory}`,
        cwd: "/",
      },
      { name: "build", source: configuration.buildCommand, cwd: directory },
    ],
    moduleMapPath: `${directory}/${configuration.moduleMapPath}`,
  };
}

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
