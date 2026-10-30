import { durableGitHubConfigurationSource } from "./github/index.js";
import { invariant } from "./invariant.js";
import { reconcileClone } from "./project-provision.js";
import { WORKSPACE_COMMAND_TIMEOUT_MS } from "./workspace-command-timeout.js";
import { shellQuote } from "./shell-quote.js";
import {
  BUILD_SCRATCH_ROOT,
  HARNESS_DIRECTORY,
  HARNESS_GIT_DIRECTORY,
  WORKSPACE_ROOT,
} from "./workspace-layout.js";
import type { HarnessCommit } from "./harness-commit.js";

type HarnessBuildPhaseName = "install" | "build-module-map";

type HarnessBuildPhase = Readonly<{ name: HarnessBuildPhaseName; command: string }>;

export type HarnessBuildConfiguration = Readonly<{
  buildRoot: string;
  harnessRepositoryRoot: string;
  harnessGitDir: string;
  harnessGitRemote: string;
  /** Order is a dependency: an extracted commit has no `node_modules`, so install comes first. */
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
      command: "pnpm install --frozen-lockfile --reporter=silent --ignore-scripts",
    },
    { name: "build-module-map", command: "pnpm run build:module-map" },
  ],
  moduleMapPath: "build/module-map.json",
  stepTimeoutMs: WORKSPACE_COMMAND_TIMEOUT_MS,
} as const satisfies HarnessBuildConfiguration;

/**
 * A fork must set `HARNESS_REPOSITORY_URL`; the default is this project's repository, so a fork's
 * own commits would never be reachable.
 */
export function harnessBuildConfiguration(
  repositoryUrl: string | undefined,
): HarnessBuildConfiguration {
  const trimmed = repositoryUrl?.trim();

  return trimmed === undefined || trimmed.length === 0
    ? HARNESS_BUILD_CONFIGURATION
    : { ...HARNESS_BUILD_CONFIGURATION, harnessGitRemote: trimmed };
}

export type HarnessBuildStepName = "provision" | "isolate" | "checkout" | HarnessBuildPhaseName;

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

export type HarnessBuildRequest =
  | Readonly<{ kind: "build-step"; harnessCommit: string; step: HarnessBuildStepName }>
  | Readonly<{ kind: "build-output"; harnessCommit: string }>;

export const HARNESS_BUILD_STEP_NAMES: readonly HarnessBuildStepName[] = [
  "provision",
  "isolate",
  "checkout",
  ...HARNESS_BUILD_CONFIGURATION.buildPhases.map((phase) => phase.name),
];

export const HARNESS_PROVISION_LOCK = "/tmp/cf-stumble-harness-provision.lock";

/**
 * Fetches the commit directly, then falls back to the remote's branches for a server that refuses a
 * request for a bare object.
 */
function obtainHarnessCommit(): readonly string[] {
  return [
    'if ! git --git-dir="$git_dir" cat-file -e "${commit}^{commit}" 2>/dev/null; then',
    '  git --git-dir="$git_dir" fetch --no-tags --quiet origin "$commit" 2>/dev/null ||',
    '    git --git-dir="$git_dir" fetch --no-tags --quiet origin ||',
    "    true",
    '  if ! git --git-dir="$git_dir" cat-file -e "${commit}^{commit}" 2>/dev/null; then',
    '    printf "harness commit %s is not in %s\\n" "$commit" "$expected_remote" >&2',
    "    exit 1",
    "  fi",
    "fi",
  ];
}

/**
 * The harness directory is an editable checkout, so the shared clone block only checks an existing
 * one and never replaces it.
 */
export function provisionHarnessRepository(
  configuration: HarnessBuildConfiguration,
  harnessCommit: HarnessCommit,
): string {
  return [
    "set -eu",
    ...durableGitHubConfigurationSource(),
    `mkdir -p ${shellQuote(WORKSPACE_ROOT)}`,
    `lock=${shellQuote(HARNESS_PROVISION_LOCK)}`,
    `repository=${shellQuote(configuration.harnessRepositoryRoot)}`,
    `git_dir=${shellQuote(configuration.harnessGitDir)}`,
    `staging=${shellQuote(`${configuration.harnessRepositoryRoot}.provisioning`)}`,
    `expected_remote=${shellQuote(configuration.harnessGitRemote)}`,
    `commit=${shellQuote(harnessCommit)}`,
    ...reconcileClone(),
    ...obtainHarnessCommit(),
  ].join("\n");
}

/**
 * The archive is written first so an archive failure fails this step instead of reaching the build
 * as an empty directory. Computer's userspace filesystem refuses `utime`, `chown` and `chmod` on
 * directories tar creates, and tar exits 2, hence the metadata flags.
 */
function checkoutSource(
  configuration: HarnessBuildConfiguration,
  directory: string,
  harnessCommit: HarnessCommit,
): string {
  return [
    "set -eu",
    `archive=${directory}/.harness-archive.tar`,
    `git --git-dir=${configuration.harnessGitDir} archive --format=tar -o "$archive" ${harnessCommit}`,
    `tar -x -m --no-same-owner --no-same-permissions -C ${directory} -f "$archive"`,
    'rm -f "$archive"',
  ].join("\n");
}

/**
 * Changes into the scratch directory itself because Computer refuses a working directory outside
 * the workspace. Keeps only the output tail because Computer holds output in memory and an
 * unbounded `pnpm install` log made the container exit. `pipefail` keeps the phase's exit code.
 */
function phaseStep(directory: string, phase: HarnessBuildPhase): HarnessBuildStep {
  return {
    name: phase.name,
    source: [
      "set -o pipefail",
      `cd ${shellQuote(directory)}`,
      `${phase.command} 2>&1 | tail -c 4000`,
    ].join("\n"),
    cwd: WORKSPACE_ROOT,
  };
}

/**
 * Interpolating the commit is safe because `HarnessCommit` accepts only lower-case hexadecimal.
 * Deleting and recreating the commit-keyed scratch directory cannot race: it belongs to the
 * tenant's own container and `WorkspaceHostModuleMapBuilder` admits one build per commit.
 * `buildRoot` holds no repository, so the delete only removes an earlier extraction of that commit.
 */
export function planHarnessBuild(
  configuration: HarnessBuildConfiguration,
  harnessCommit: HarnessCommit,
): HarnessBuildPlan {
  const directory = `${configuration.buildRoot}/${harnessCommit}`;
  invariant(
    !`${configuration.harnessRepositoryRoot}/`.startsWith(`${directory}/`),
    "build scratch must never contain the harness checkout",
  );

  return {
    directory,
    steps: [
      {
        name: "provision",
        source: provisionHarnessRepository(configuration, harnessCommit),
        cwd: WORKSPACE_ROOT,
      },
      {
        name: "isolate",
        source: `mkdir -p ${configuration.buildRoot} && rm -rf ${directory} && mkdir -p ${directory}`,
        cwd: WORKSPACE_ROOT,
      },
      {
        name: "checkout",
        source: checkoutSource(configuration, directory, harnessCommit),
        cwd: WORKSPACE_ROOT,
      },
      ...configuration.buildPhases.map((phase) => phaseStep(directory, phase)),
    ],
    moduleMapPath: `${directory}/${configuration.moduleMapPath}`,
  };
}

export function harnessBuildStep(
  plan: HarnessBuildPlan,
  name: HarnessBuildStepName,
): HarnessBuildStep {
  const step = plan.steps.find((planned) => planned.name === name);
  invariant(step !== undefined, `the build plan must contain its own ${name} step`);

  return step;
}
