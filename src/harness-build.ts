import { WORKSPACE_COMMAND_TIMEOUT_MS } from "./workspace-command-timeout.js";

type HarnessBuildPhaseName = "install" | "build-module-map";

export type HarnessBuildPhase = Readonly<{ name: HarnessBuildPhaseName; command: string }>;

export type HarnessBuildConfiguration = Readonly<{
  harnessGitRemote: string;
  buildPhases: readonly [HarnessBuildPhase, ...HarnessBuildPhase[]];
  moduleMapPath: string;
  stepTimeoutMs: number;
}>;

export const HARNESS_BUILD_CONFIGURATION = {
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

export type HarnessBuildStepRequest = Readonly<{ harnessCommit: string; step: string }>;

export const HARNESS_BUILD_STEP_NAMES: readonly HarnessBuildStepName[] = [
  "provision",
  "isolate",
  "checkout",
  ...HARNESS_BUILD_CONFIGURATION.buildPhases.map((phase) => phase.name),
];

export function isHarnessBuildStep(name: string): name is HarnessBuildStepName {
  return HARNESS_BUILD_STEP_NAMES.some((known) => known === name);
}
