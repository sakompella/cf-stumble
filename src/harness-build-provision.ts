import { durableGitHubConfigurationSource } from "./github/index.js";
import { shellQuote } from "./shell-quote.js";
import { reconcileClone } from "./project-provision.js";
import { WORKSPACE_ROOT } from "./workspace-layout.js";
import type { HarnessBuildConfiguration } from "./harness-build.js";
import type { HarnessCommit } from "./harness-commit.js";

/**
 * The provision step of a harness build, as shell text. It is here rather than in
 * `harness-build.ts` because the rest of that module is the shape of a build, and this is one
 * step's worth of shell that has to survive a dead lock holder, an unrelated directory where the
 * checkout belongs, and a commit pushed after the checkout was provisioned.
 */

/**
 * The file the harness provision step locks with `holdProvisionLock`.
 *
 * Earlier builds locked with a `harness.provision-lock` directory beside the checkout. That
 * directory is ignored, not deleted.
 */
export const HARNESS_PROVISION_LOCK = "/tmp/cf-stumble-harness-provision.lock";

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

/**
 * Make the harness repository exist and point at the configured remote, then obtain the requested
 * commit. The harness directory is the owner's editable checkout in the shared workspace
 * (ADR-0038), not scratch a build owns, so the shared clone block only checks an existing checkout
 * and never replaces it.
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
