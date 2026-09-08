import { invariant } from "./invariant.js";
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
   * The one package script that turns an extracted commit into a module map. It must install from
   * the lockfile and build the vendored Pi package before it runs esbuild, because the extracted
   * commit contains neither `node_modules` nor Pi's generated `dist/`, and it must name a script
   * rather than spell out a command line, so the deployed build and the local gate cannot drift
   * apart. `test/supervisor/artifacts/build-command.test.ts` checks that `package.json` defines
   * it.
   */
  buildCommand: string;
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
  buildCommand: "pnpm run build:artifact",
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

export type HarnessBuildStepName = "provision" | "isolate" | "checkout" | "build";

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
  "provision",
  "isolate",
  "checkout",
  "build",
];

/** Hold the provision lock for the rest of the step, taking it from a process that has died. */
function holdProvisionLock(): readonly string[] {
  return [
    'while ! mkdir "$lock" 2>/dev/null; do',
    '  owner="$(cat "$lock/pid" 2>/dev/null || true)"',
    '  if [ -z "$owner" ] || ! kill -0 "$owner" 2>/dev/null; then',
    '    stale_lock="${lock}.stale.$$"',
    '    if mv "$lock" "$stale_lock" 2>/dev/null; then',
    '      rm -rf "$stale_lock"',
    "    fi",
    "  else",
    "    sleep 1",
    "  fi",
    "done",
    'printf "%s\\n" "$$" > "$lock/pid"',
    "trap 'rm -rf \"$lock\"' EXIT",
  ];
}

/**
 * Make the harness repository exist and point at the configured remote.
 *
 * The harness directory is the owner's editable checkout in the shared workspace (ADR-0038), not
 * scratch this function owns, so a build never replaces it. An existing repository is only
 * checked; a directory that is populated but is not a repository fails the step and is left as it
 * was found; and a fresh clone lands beside the root and moves into place once it is complete, so
 * an interrupted provision leaves the owner with what was there rather than with neither the
 * previous checkout nor a usable replacement. `rmdir` removes the root only when it is an empty
 * directory, which is the one case where there is nothing to lose.
 */
function reconcileHarnessRepository(): readonly string[] {
  return [
    'if ! test "$(git --git-dir="$git_dir" rev-parse --is-bare-repository 2>/dev/null)" = false; then',
    '  if test -e "$repository" && test -n "$(ls -A "$repository" 2>/dev/null)"; then',
    '    printf "%s is not a git repository and is not empty\\n" "$repository" >&2',
    "    exit 1",
    "  fi",
    '  incoming="${repository}.incoming.$$"',
    '  rm -rf "$incoming"',
    '  git clone "$expected_remote" "$incoming"',
    '  rmdir "$repository" 2>/dev/null || true',
    '  mv "$incoming" "$repository"',
    "fi",
    'actual_remote="$(git --git-dir="$git_dir" config --get-all remote.origin.url || true)"',
    'test "$actual_remote" = "$expected_remote"',
  ];
}

/**
 * Obtain the requested commit. A commit submitted after this checkout was provisioned is not here
 * yet, so ask the remote for that commit, then fall back to the remote's branches for a server
 * that refuses a request for a bare object, and then stop. Two attempts bound the work, and the
 * message names the commit and the repository the build looked in, which is what the owner needs
 * in order to correct the request.
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

function provisionHarnessRepository(
  configuration: HarnessBuildConfiguration,
  harnessCommit: HarnessCommit,
): string {
  const lock = `${configuration.harnessRepositoryRoot}.provision-lock`;
  return [
    "set -eu",
    `mkdir -p ${shellQuote(WORKSPACE_ROOT)}`,
    `lock=${shellQuote(lock)}`,
    `repository=${shellQuote(configuration.harnessRepositoryRoot)}`,
    `git_dir=${shellQuote(configuration.harnessGitDir)}`,
    `expected_remote=${shellQuote(configuration.harnessGitRemote)}`,
    `commit=${shellQuote(harnessCommit)}`,
    ...holdProvisionLock(),
    ...reconcileHarnessRepository(),
    ...obtainHarnessCommit(),
  ].join("\n");
}

/**
 * Plan the whole build as plain command strings. Provisioning reconciles the harness repository
 * and obtains the named commit, then `git archive` extracts that commit into a scratch directory
 * of its own, so no step mutates the editable harness checkout and a repeated build of one commit
 * starts from the same files. Interpolating the commit is safe because `HarnessCommit` accepts
 * only lower-case hexadecimal object IDs.
 *
 * Install location: the build step runs in the extracted directory, so `pnpm install` writes
 * `node_modules` inside that per-commit directory and nothing is borrowed from a parent checkout.
 * Only the content-addressed pnpm store is shared between builds, because the store is keyed by
 * package content and concurrent writes to it are the package manager's problem, not this plan's.
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
      {
        // Two things this command does beyond running the build script. It changes into the scratch
        // directory itself, because Computer resolves a working directory against the workspace and
        // refuses one outside it (`workspace-layout.ts`). And it keeps only the tail of the build's
        // own output: Computer holds a command's output in memory, and an unbounded `pnpm install`
        // log was enough to make the deployed container exit 1 part way through every build. The
        // output is read only when a step fails, so a bounded tail loses nothing. `pipefail` keeps
        // the build's exit code rather than `tail`'s.
        name: "build",
        source: [
          "set -o pipefail",
          `cd ${shellQuote(directory)}`,
          `${configuration.buildCommand} 2>&1 | tail -c 4000`,
        ].join("\n"),
        cwd: WORKSPACE_ROOT,
      },
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
