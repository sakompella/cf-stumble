import { shellQuote } from "./shell-quote.js";
import { WORKSPACE_ROOT } from "./workspace-layout.js";
import type { HarnessBuildConfiguration } from "./harness-build.js";
import type { HarnessCommit } from "./harness-commit.js";

/**
 * The provision step of a harness build, as shell text. It is here rather than in
 * `harness-build.ts` because the rest of that module is the shape of a build, and this is one
 * step's worth of shell that has to survive a dead lock holder, an unrelated directory where the
 * checkout belongs, and a commit pushed after the checkout was provisioned.
 */

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

export function provisionHarnessRepository(
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
