import { invariant } from "./invariant.js";
import { provisionHarnessRepository } from "./harness-build-provision.js";
import { WORKSPACE_COMMAND_TIMEOUT_MS } from "./workspace-command-timeout.js";
import { shellQuote } from "./shell-quote.js";
import {
  BUILD_SCRATCH_ROOT,
  HARNESS_DIRECTORY,
  HARNESS_GIT_DIRECTORY,
  WORKSPACE_ROOT,
} from "./workspace-layout.js";
import type { HarnessCommit } from "./harness-commit.js";

export { shellQuote };

export type HarnessBuildPhaseName = "install" | "build-pi" | "build-module-map";

/** One phase of a build: a name a failure can report, and the command that phase runs. */
export type HarnessBuildPhase = Readonly<{ name: HarnessBuildPhaseName; command: string }>;

/**
 * Where and how one labeled harness commit becomes a module map. Version 0 has one build path, so
 * these values are fixed here rather than chosen per request.
 *
 * Every path comes from `workspace-layout.ts`, which owns the layout of the tenant's one shared
 * workspace (ADR-0038). The harness repository is an ordinary editable checkout beside the project
 * clones, and `buildRoot` is a separate scratch subtree that holds no repository, so a build
 * extracts and compiles without ever writing inside the harness checkout or a project.
 *
 * This module is shared by the workspace that runs a build and the Supervisor that asks for one,
 * so both plan a commit the same way. It holds plain values only, and imports no platform API.
 */
export type HarnessBuildConfiguration = Readonly<{
  buildRoot: string;
  harnessRepositoryRoot: string;
  harnessGitDir: string;
  harnessGitRemote: string;
  /**
   * The phases that turn an extracted commit into a module map, in the order they run. They are
   * separate because one command was not survivable: three deployed builds of one commit died at
   * 671 s, 692 s and 696 s, one of them with an empty stdout and an empty stderr, and the whole
   * eleven minutes reported nothing about which phase was running. A phase is its own step, so it
   * is its own RPC, its own exit code and its own bounded tail.
   *
   * Order is a dependency, not a preference. An extracted commit contains neither `node_modules`
   * nor Pi's generated `dist/`, so the install comes first and esbuild cannot resolve
   * `@cf-stumble/pi` until Pi is built.
   *
   * Each command names a script `package.json` defines, or is a flag-only `pnpm install`, so the
   * deployed build and the local gate cannot drift apart.
   * `test/supervisor/artifacts/build-command.test.ts` holds that rule and checks these phases
   * against `build:artifact`, which is what a developer and the clean-build probe run locally.
   */
  buildPhases: readonly [HarnessBuildPhase, ...HarnessBuildPhase[]];
  moduleMapPath: string;
  /** How long one build step may run (`workspace-command-timeout.ts`). */
  stepTimeoutMs: number;
}>;

/** The one build configuration the Workspace Host offers and the Supervisor plans against. */
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
    { name: "build-pi", command: "pnpm run build:pi" },
    { name: "build-module-map", command: "pnpm run build:module-map" },
  ],
  moduleMapPath: "build/module-map.json",
  stepTimeoutMs: WORKSPACE_COMMAND_TIMEOUT_MS,
} as const satisfies HarnessBuildConfiguration;

/**
 * The build configuration a deployment runs with.
 *
 * `HARNESS_REPOSITORY_URL` is the one setting a fork has to change. The default is the project's
 * own repository, which is right for the owner's instance and wrong for everybody else: a deploy
 * button user's instance would clone and build this repository instead of their fork, and their
 * own harness commits would never be reachable. A deployment sets that variable to its own
 * repository and changes nothing else.
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

/**
 * What a caller may ask a build workspace to do. It names a labeled commit and one planned step,
 * so command text has no field to arrive in.
 */
export type HarnessBuildRequest =
  | Readonly<{ kind: "build-step"; harnessCommit: string; step: HarnessBuildStepName }>
  | Readonly<{ kind: "build-output"; harnessCommit: string }>;

/**
 * Every step a caller may name. It is derived from the one configuration's phases, so a phase
 * added there is accepted by the RPC parser and a name that is not planned stays an
 * `unknown-command`.
 */
export const HARNESS_BUILD_STEP_NAMES: readonly HarnessBuildStepName[] = [
  "provision",
  "isolate",
  "checkout",
  ...HARNESS_BUILD_CONFIGURATION.buildPhases.map((phase) => phase.name),
];

/**
 * `git archive | tar -x` reports tar's exit code, so a failed archive used to reach the build step
 * as an empty directory and a confusing compilation error. Writing the archive first makes an
 * archive failure the step's own failure.
 *
 * The metadata flags are not tidiness. The deployed workspace filesystem is Computer's userspace
 * shim, because a Cloudflare container cannot grant the privileges a kernel FUSE mount needs. That
 * filesystem refuses `utime`, `chown` and `chmod` on a directory tar has just created, and tar
 * exits 2 on those errors, which failed every deployed checkout.
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
 * One compile phase as a step of its own.
 *
 * Two things this command does beyond running the phase. It changes into the scratch directory
 * itself, because Computer resolves a working directory against the workspace and refuses one
 * outside it (`workspace-layout.ts`). And it keeps only the tail of the phase's own output:
 * Computer holds a command's output in memory, and an unbounded `pnpm install` log was enough to
 * make the deployed container exit 1 part way through every build. The output is read only when a
 * step fails, so a bounded tail loses nothing, and a tail per phase is a tail of the phase that
 * failed rather than of whatever the last eleven minutes ended on. `pipefail` keeps the phase's
 * exit code rather than `tail`'s.
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
 * Plan the whole build as plain command strings. Provisioning reconciles the harness repository
 * and obtains the named commit, then `git archive` extracts that commit into a scratch directory
 * of its own, so no step mutates the editable harness checkout and a repeated build of one commit
 * starts from the same files. Interpolating the commit is safe because `HarnessCommit` accepts
 * only lower-case hexadecimal object IDs.
 *
 * Install location: every compile phase runs in the extracted directory, so `pnpm install` writes
 * `node_modules` inside that per-commit directory and the phases after it find it there, and
 * nothing is borrowed from a parent checkout. Only the content-addressed pnpm store is shared
 * between builds, because the store is keyed by package content and concurrent writes to it are
 * the package manager's problem, not this plan's.
 *
 * Same-commit concurrency (T1a's handed-over race). The isolate step still deletes and recreates a
 * directory keyed only by the commit, because both sides of the build plan the same steps from the
 * commit alone and a per-build directory name would have to travel in the request to stay
 * agreeable. Two things make that safe instead. The scratch subtree now lives inside the tenant's
 * own workspace rather than in a globally named build container, so two tenants building one
 * commit no longer share a filesystem at all; and `WorkspaceHostModuleMapBuilder` admits one build
 * per commit at a time, so a second request for a commit already building joins that build instead
 * of starting a rival one that would delete its tree. Nothing here schedules or queues: a build
 * either is the one in flight or waits for its result.
 *
 * Blast radius: `buildRoot` holds no repository, so the delete can only ever remove a previous
 * extraction of the same commit. The invariant below refuses a configuration in which the harness
 * checkout would sit inside the directory a build deletes.
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

/** The step of a commit's build plan, named rather than described by its command text. */
export function harnessBuildStep(
  plan: HarnessBuildPlan,
  name: HarnessBuildStepName,
): HarnessBuildStep {
  const step = plan.steps.find((planned) => planned.name === name);
  invariant(step !== undefined, `the build plan must contain its own ${name} step`);

  return step;
}
