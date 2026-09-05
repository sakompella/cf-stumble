import { invariant } from "./invariant.js";
import { shellQuote } from "./shell-quote.js";
import type { HarnessCommit } from "./harness-commit.js";

export { shellQuote };

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
}>;

/** The one build configuration the Workspace Host offers and the Supervisor plans against. */
export const HARNESS_BUILD_CONFIGURATION = {
  buildRoot: "/harness-builds",
  harnessRepositoryRoot: "/harness",
  harnessGitDir: "/harness/.git",
  harnessGitRemote: "https://github.com/sakompella/cf-stumble.git",
  buildCommand: "pnpm run build:artifact",
  moduleMapPath: "build/module-map.json",
} as const satisfies HarnessBuildConfiguration;

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
 * Make the harness repository exist and point at the configured remote. The replacement clone
 * lands beside the repository root and moves into place once it is complete, because removing the
 * root first would let an interrupted provision leave the owner with neither the editable harness
 * checkout that was there nor a usable replacement.
 */
function reconcileHarnessRepository(): readonly string[] {
  return [
    'if ! test "$(git --git-dir="$git_dir" rev-parse --is-bare-repository 2>/dev/null)" = false; then',
    '  incoming="${repository}.incoming.$$"',
    '  rm -rf "$incoming"',
    '  git clone --no-checkout "$expected_remote" "$incoming"',
    '  rm -rf "$repository"',
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
 * Plan the whole build as plain command strings. Provisioning reconciles the dedicated harness
 * repository and obtains the named commit, then `git archive` extracts that commit into a
 * directory of its own, so no step mutates a shared working tree and a repeated build of one
 * commit starts from the same files. Interpolating the commit is safe because `HarnessCommit`
 * accepts only lower-case hexadecimal object IDs.
 *
 * Install location: the build step runs in the extracted directory, so `pnpm install` writes
 * `node_modules` inside that per-commit directory and nothing is borrowed from a parent checkout.
 * Only the content-addressed pnpm store is shared between builds, because the store is keyed by
 * package content and concurrent writes to it are the package manager's problem, not this plan's.
 *
 * Known race, owned by roadmap task T3.4: the directory is keyed only by the commit, and the
 * isolate step deletes it, so two builds of one commit delete each other's tree. Installing inside
 * the directory puts `node_modules` in that blast radius as well. This plan does not serialize
 * same-commit builds; T3 must give the isolate step a per-build directory or a lock, and the whole
 * build must then run in the directory it isolated.
 */
export function planHarnessBuild(
  configuration: HarnessBuildConfiguration,
  harnessCommit: HarnessCommit,
): HarnessBuildPlan {
  const directory = `${configuration.buildRoot}/${harnessCommit}`;
  return {
    directory,
    steps: [
      {
        name: "provision",
        source: provisionHarnessRepository(configuration, harnessCommit),
        cwd: "/",
      },
      { name: "isolate", source: `rm -rf ${directory} && mkdir -p ${directory}`, cwd: "/" },
      {
        name: "checkout",
        // `git archive | tar -x` reports tar's exit code, so a failed archive reached the build
        // step as an empty directory and a confusing compilation error. Writing the archive
        // first makes an archive failure the step's own failure.
        source: [
          "set -eu",
          `archive=${directory}/.harness-archive.tar`,
          `git --git-dir=${configuration.harnessGitDir} archive --format=tar -o "$archive" ${harnessCommit}`,
          `tar -x -C ${directory} -f "$archive"`,
          'rm -f "$archive"',
        ].join("\n"),
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
