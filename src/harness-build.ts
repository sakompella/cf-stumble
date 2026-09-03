import { invariant } from "./invariant.js";
import type { HarnessCommit } from "./harness-commit.js";

/**
 * Where and how one labeled harness commit becomes a module map. Version 0 has one build path, so
 * these values are fixed here rather than chosen per request. `buildRoot` is not the project
 * workspace root: a build must not see or touch project files.
 *
 * This module is shared by the workspace that runs a build and the Supervisor that asks for one,
 * so both plan a commit the same way. It holds plain values only, and imports no platform API.
 */
export type HarnessBuildConfiguration = Readonly<{
  buildRoot: string;
  harnessGitDir: string;
  buildCommand: string;
  moduleMapPath: string;
}>;

/** The one build configuration the Workspace Host offers and the Supervisor plans against. */
export const HARNESS_BUILD_CONFIGURATION = {
  buildRoot: "/harness-builds",
  harnessGitDir: "/harness/.git",
  buildCommand: "pnpm run build:module-map",
  moduleMapPath: "build/module-map.json",
} as const satisfies HarnessBuildConfiguration;

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

/**
 * What a caller may ask a build workspace to do. It names a labeled commit and one planned step,
 * so command text has no field to arrive in.
 */
export type HarnessBuildRequest =
  | Readonly<{ kind: "build-step"; harnessCommit: string; step: HarnessBuildStepName }>
  | Readonly<{ kind: "build-output"; harnessCommit: string }>;

export const HARNESS_BUILD_STEP_NAMES: readonly HarnessBuildStepName[] = [
  "isolate",
  "checkout",
  "build",
];

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

/** The step of a commit's build plan, named rather than described by its command text. */
export function harnessBuildStep(
  plan: HarnessBuildPlan,
  name: HarnessBuildStepName,
): HarnessBuildStep {
  const step = plan.steps.find((planned) => planned.name === name);
  invariant(step !== undefined, `the build plan must contain its own ${name} step`);
  return step;
}
