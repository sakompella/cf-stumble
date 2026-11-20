import {
  durableGitHubConfigurationSource,
  REPOSITORY_SIZE_VERDICT_FUNCTION,
  repositorySizeVerdictSource,
} from "../github/index.js";
import { shellQuote } from "../shell-quote.js";

const CLONE_DEPTH = 50;

export const CLONE_SIZE_FAILURE_EXIT_CODE = 122;

export const MEASURED_SIZE_VERDICTS = [
  "tree-truncated",
  "too-many-files",
  "working-tree-too-large",
  "repository-too-large",
] as const;

export function holdProvisionLock(): readonly string[] {
  return ['exec 9>"$lock"', "flock 9"];
}

const CLONE_INTO_STAGING = `git clone --filter=blob:none --depth=${CLONE_DEPTH} --single-branch "$expected_remote" "$staging"`;

const REFUSE_MEASURED_SIZE = [
  `  size_verdict="$(${REPOSITORY_SIZE_VERDICT_FUNCTION})"`,
  '  case "$size_verdict" in',
  `    ${MEASURED_SIZE_VERDICTS.join(" | ")})`,
  String.raw`      printf "repository exceeds a workspace size limit: %s\n" "$size_verdict" >&2`,
  String.raw`      printf "size-verdict=%s\n" "$size_verdict"`,
  `      exit ${CLONE_SIZE_FAILURE_EXIT_CODE}`,
  "      ;;",
  "  esac",
];

const CLONE_REFUSING_A_FULL_DISK = [
  `  if clone_output="$(${CLONE_INTO_STAGING} 2>&1)"; then`,
  "    :",
  "  else",
  "    clone_exit=$?",
  `    if printf '%s\\n' "$clone_output" | grep -Eiq 'no space left on device|disk quota exceeded|not enough space'; then`,
  String.raw`      printf "repository clone exceeded workspace capacity\n" >&2`,
  String.raw`      printf "size-verdict=capacity-exceeded\n"`,
  `      exit ${CLONE_SIZE_FAILURE_EXIT_CODE}`,
  "    fi",
  String.raw`    printf "%s\n" "$clone_output" >&2`,
  '    exit "$clone_exit"',
  "  fi",
];

export type RepositoryClone = Readonly<{
  remote: string;
  root: string;
  gitDir: string;
  lock: string;
}>;

export function cloneRepositorySource(clone: RepositoryClone): string {
  const { remote, root, gitDir, lock } = clone;

  return [
    "set -eu",
    ...durableGitHubConfigurationSource(),
    `lock=${shellQuote(lock)}`,
    `repository=${shellQuote(root)}`,
    `git_dir=${shellQuote(gitDir)}`,
    `staging=${shellQuote(`${root}.provisioning`)}`,
    `expected_remote=${shellQuote(remote)}`,
    repositorySizeVerdictSource(remote),
    `mkdir -p ${shellQuote(root.slice(0, root.lastIndexOf("/")))}`,
    ...holdProvisionLock(),
    "trap 'rm -rf \"$staging\"' EXIT",
    'if ! test "$(git --git-dir="$git_dir" rev-parse --is-bare-repository 2>/dev/null)" = false; then',
    '  if test -e "$repository" && test -n "$(ls -A "$repository" 2>/dev/null)"; then',
    String.raw`    printf "%s is not a git repository and is not empty\n" "$repository" >&2`,
    "    exit 1",
    "  fi",
    ...REFUSE_MEASURED_SIZE,
    '  rm -rf "$staging"',
    ...CLONE_REFUSING_A_FULL_DISK,
    '  git -C "$staging" config core.fileMode false',
    '  rmdir "$repository" 2>/dev/null || true',
    '  mv "$staging" "$repository"',
    "fi",
    'actual_remote="$(git --git-dir="$git_dir" config --get-all remote.origin.url || true)"',
    'if test "$actual_remote" != "$expected_remote"; then',
    String.raw`  printf "%s has a different origin than %s\n" "$repository" "$expected_remote" >&2`,
    "  exit 1",
    "fi",
  ].join("\n");
}
