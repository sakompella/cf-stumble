import * as Effect from "effect/Effect";
import type { HarnessBuildConfiguration } from "../harness-build.js";
import type { HarnessCommit } from "../harness-commit.js";
import { shellQuote } from "../shell-quote.js";
import { cloneRepositorySource } from "./clone-script.js";
import type { CommandOutput, WorkspaceFault } from "./operations.js";

const HARNESS_FETCH_DEPTH = 50;

const HARNESS_PROVISION_LOCK_PATH = "/tmp/cf-stumble-harness.provision.lock";

type Container = (source: string) => Effect.Effect<CommandOutput, WorkspaceFault>;

function harnessSource(configuration: HarnessBuildConfiguration, commit: HarnessCommit): string {
  const dir = configuration.harnessRepositoryRoot;
  const remote = configuration.harnessGitRemote;

  return [
    cloneRepositorySource({
      remote,
      root: dir,
      gitDir: configuration.harnessGitDir,
      lock: HARNESS_PROVISION_LOCK_PATH,
    }),
    `cd ${shellQuote(dir)}`,
    `if ! git cat-file -e ${commit}^{commit} 2>/dev/null; then`,
    `  if ! reason="$(git fetch --quiet --depth=${HARNESS_FETCH_DEPTH} origin ${commit} 2>&1 && git cat-file -e ${commit}^{commit} 2>&1)"; then`,
    `    printf 'harness commit %s is not in %s%s\\n' ${commit} ${shellQuote(remote)} "\${reason:+: $reason}" >&2`,
    "    exit 1",
    "  fi",
    "fi",
    'head="$(git rev-parse --short=7 HEAD)"',
    "stuck() {",
    `  printf 'harness checkout not updated: cannot fast-forward from %s\\n' "$head" >&2`,
    "  exit 0",
    "}",
    'branch="$(git symbolic-ref --quiet --short HEAD)" || stuck',
    'upstream="refs/remotes/origin/$branch"',
    'if ! git fetch --quiet origin "+refs/heads/$branch:$upstream" 2>/dev/null; then',
    "  printf 'harness checkout not updated: fetch failed\\n' >&2",
    "  exit 0",
    "fi",
    "if ! git diff --quiet HEAD --; then",
    `  printf 'harness checkout has local changes; left at %s\\n' "$head" >&2`,
    "  exit 0",
    "fi",
    "while :; do",
    '  git merge-base --is-ancestor "$upstream" HEAD 2>/dev/null && exit 0',
    '  if git merge-base --is-ancestor HEAD "$upstream" 2>/dev/null; then',
    '    git merge --ff-only --quiet "$upstream" >/dev/null 2>&1 || stuck',
    "    exit 0",
    "  fi",
    '  [ "$(git rev-parse --is-shallow-repository)" = true ] || stuck',
    '  git fetch --quiet --unshallow origin "+refs/heads/$branch:$upstream" 2>/dev/null || stuck',
    "done",
  ].join("\n");
}

export function provisionHarness(
  container: Container,
  configuration: HarnessBuildConfiguration,
  commit: HarnessCommit,
): Effect.Effect<CommandOutput, WorkspaceFault> {
  return container(harnessSource(configuration, commit)).pipe(
    Effect.map((ran) => ({ stdout: "", stderr: ran.stderr, exitCode: ran.exitCode })),
  );
}
