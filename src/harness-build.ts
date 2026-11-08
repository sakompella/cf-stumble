import { WORKSPACE_COMMAND_TIMEOUT_MS } from "./workspace-command-timeout.js";
import {
  BUILD_SCRATCH_ROOT,
  HARNESS_DIRECTORY,
  HARNESS_GIT_DIRECTORY,
} from "./workspace-layout.js";

type HarnessBuildPhaseName = "install" | "build-module-map";

export type HarnessBuildPhase = Readonly<{ name: HarnessBuildPhaseName; command: string }>;

export type HarnessBuildConfiguration = Readonly<{
  buildRoot: string;
  harnessRepositoryRoot: string;
  harnessGitDir: string;
  harnessGitRemote: string;
  buildPhases: readonly [HarnessBuildPhase, ...HarnessBuildPhase[]];
  moduleMapPath: string;
  stepTimeoutMs: number;
}>;

export const HARNESS_BUILD_CONFIGURATION = {
  buildRoot: BUILD_SCRATCH_ROOT,
  harnessRepositoryRoot: HARNESS_DIRECTORY,
  harnessGitDir: HARNESS_GIT_DIRECTORY,
  harnessGitRemote: "https://github.com/sakompella/cf-stumble.git",
  buildPhases: [
    {
      name: "install",
      command: "pnpm install --frozen-lockfile --prod --reporter=silent --ignore-scripts",
    },
    { name: "build-module-map", command: "pnpm run build:module-map" },
  ],
  moduleMapPath: "build/module-map.json",
  stepTimeoutMs: WORKSPACE_COMMAND_TIMEOUT_MS,
} as const satisfies HarnessBuildConfiguration;

export type HarnessBuildStepName = "provision" | "isolate" | "checkout" | HarnessBuildPhaseName;

export type HarnessBuildRequest =
  | Readonly<{ kind: "build-step"; harnessCommit: string; step: HarnessBuildStepName }>
  | Readonly<{ kind: "build-output"; harnessCommit: string }>
  | Readonly<{ kind: "build-discard"; harnessCommit: string }>;

export const HARNESS_BUILD_STEP_NAMES: readonly HarnessBuildStepName[] = [
  "provision",
  "isolate",
  "checkout",
  ...HARNESS_BUILD_CONFIGURATION.buildPhases.map((phase) => phase.name),
];
