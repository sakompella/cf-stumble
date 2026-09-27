import type { PublicRepositoryUrl } from "../project-catalog.js";
import { shellQuote } from "../shell-quote.js";
import {
  MAX_REPOSITORY_BLOB_BYTES,
  MAX_REPOSITORY_BLOB_COUNT,
  MAX_REPOSITORY_SIZE_KB,
  REPOSITORY_SIZE_TIMEOUT_MS,
  REPOSITORY_TREE_MUST_BE_COMPLETE,
  repositoryApiPath,
} from "./repository-size.js";

/** The shell function that `repositorySizeVerdictSource` defines. */
export const REPOSITORY_SIZE_VERDICT_FUNCTION = "repository_size_verdict";

const REQUEST_TIMEOUT_SECONDS = Math.ceil(REPOSITORY_SIZE_TIMEOUT_MS / 1_000);

/**
 * Prints `<size-kb> <url-encoded default branch>` for a well-formed repository response, and
 * `unmeasured` otherwise. The safe-integer bound keeps jq printing the size as plain digits.
 */
const REPOSITORY_FILTER = [
  'if (.size | type) == "number" and .size >= 0 and .size == (.size | floor)',
  "and .size <= 9007199254740991",
  'and (.default_branch | type) == "string" and .default_branch != ""',
  'then "\\(.size) \\(.default_branch | @uri)"',
  'else "unmeasured" end',
].join(" ");

/**
 * Applies the tree ceilings in the order `repositorySizeReason` does. It prints `measured` when the
 * tree is within them, which leaves only the repository-size ceiling to the shell.
 */
const TREE_FILTER = [
  'if (.tree | type) != "array" or (.truncated | type) != "boolean" then "unmeasured"',
  'else [.tree[] | select(type == "object" and .type == "blob") | .size] as $sizes',
  '| if ($sizes | all(type == "number" and . >= 0 and . == floor)) | not then "unmeasured"',
  `elif ${String(REPOSITORY_TREE_MUST_BE_COMPLETE)} and .truncated then "tree-truncated"`,
  `elif ($sizes | length) > ${String(MAX_REPOSITORY_BLOB_COUNT)} then "too-many-files"`,
  `elif ($sizes | add // 0) > ${String(MAX_REPOSITORY_BLOB_BYTES)} then "working-tree-too-large"`,
  'else "measured" end',
  "end",
].join(" ");

/**
 * Shell text that defines `repository_size_verdict`, which measures one repository with the
 * workspace's own `gh` credential. It prints one `RepositorySizeReason`, or `unmeasured`.
 *
 * The Supervisor's preflight can only use `GH_TOKEN`, so it cannot see a private repository that
 * the owner authorized through the device flow. This check runs inside the workspace, where that
 * credential lives, and makes the same two REST requests: the repository's `size` in kilobytes and
 * its default branch, then that branch's recursive tree, whose blob sizes are bytes. `gh` reads the
 * credential from its own configuration, so no token appears in this text, on a command line, or
 * in what the function prints.
 *
 * Any failure to measure prints `unmeasured`: no `gh`, no credential, a failed, slow, or
 * rate-limited request, or a response of the wrong shape. The caller then clones anyway, which
 * keeps the fail-open policy of the Supervisor's preflight for transient GitHub problems. `timeout`
 * bounds each request when the image provides it.
 */
export function repositorySizeVerdictSource(repositoryUrl: PublicRepositoryUrl): string {
  const apiPath = repositoryApiPath(repositoryUrl);

  if (apiPath === undefined) {
    return `${REPOSITORY_SIZE_VERDICT_FUNCTION}() { printf 'unmeasured\\n'; }`;
  }

  return [
    `${REPOSITORY_SIZE_VERDICT_FUNCTION}() {`,
    "  if ! command -v gh >/dev/null 2>&1; then",
    "    printf 'unmeasured\\n'",
    "    return 0",
    "  fi",
    "  if command -v timeout >/dev/null 2>&1; then",
    `    bounded_gh() { timeout ${String(REQUEST_TIMEOUT_SECONDS)} gh "$@"; }`,
    "  else",
    '    bounded_gh() { gh "$@"; }',
    "  fi",
    `  repository_line="$(bounded_gh api ${shellQuote(apiPath)} --jq ${shellQuote(REPOSITORY_FILTER)} 2>/dev/null)" || repository_line=unmeasured`,
    '  size_kb="${repository_line%% *}"',
    '  branch="${repository_line#* }"',
    '  case "$size_kb" in',
    "    '' | *[!0-9]*)",
    "      printf 'unmeasured\\n'",
    "      return 0",
    "      ;;",
    "  esac",
    `  tree_verdict="$(bounded_gh api ${shellQuote(`${apiPath}/git/trees/`)}"$branch"'?recursive=1' --jq ${shellQuote(TREE_FILTER)} 2>/dev/null)" || tree_verdict=unmeasured`,
    '  case "$tree_verdict" in',
    "    measured)",
    `      if [ "$size_kb" -gt ${String(MAX_REPOSITORY_SIZE_KB)} ]; then`,
    "        printf 'repository-too-large\\n'",
    "      else",
    "        printf 'within-limits\\n'",
    "      fi",
    "      ;;",
    "    tree-truncated | too-many-files | working-tree-too-large)",
    "      printf '%s\\n' \"$tree_verdict\"",
    "      ;;",
    "    *)",
    "      printf 'unmeasured\\n'",
    "      ;;",
    "  esac",
    "}",
  ].join("\n");
}
