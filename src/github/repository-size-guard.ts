import type { PublicRepositoryUrl } from "../project-catalog.js";
import { shellQuote } from "../shell-quote.js";

export const MAX_REPOSITORY_BLOB_COUNT = 3_000;

export const MAX_REPOSITORY_BLOB_BYTES = 150_000_000;

export const MAX_REPOSITORY_SIZE_KB = 5_000_000;

export const REPOSITORY_SIZE_VERDICT_FUNCTION = "repository_size_verdict";

const REQUEST_TIMEOUT_SECONDS = 5;

const REPOSITORY_FILTER = [
  'if (.size | type) == "number" and .size >= 0 and .size == (.size | floor)',
  "and .size <= 9007199254740991",
  'and (.default_branch | type) == "string" and .default_branch != ""',
  'then "\\(.size) \\(.default_branch | @uri)"',
  'else "unmeasured" end',
].join(" ");

const TREE_FILTER = [
  'if (.tree | type) != "array" or (.truncated | type) != "boolean" then "unmeasured"',
  'else [.tree[] | select(type == "object" and .type == "blob") | .size] as $sizes',
  '| if ($sizes | all(type == "number" and . >= 0 and . == floor)) | not then "unmeasured"',
  'elif .truncated then "tree-truncated"',
  `elif ($sizes | length) > ${String(MAX_REPOSITORY_BLOB_COUNT)} then "too-many-files"`,
  `elif ($sizes | add // 0) > ${String(MAX_REPOSITORY_BLOB_BYTES)} then "working-tree-too-large"`,
  'else "measured" end',
  "end",
].join(" ");

function repositoryApiPath(repositoryUrl: PublicRepositoryUrl): string | undefined {
  const url = new URL(repositoryUrl);
  const segments = url.pathname.split("/").filter((segment) => segment.length > 0);

  return url.hostname === "github.com" && segments.length === 2
    ? `repos/${segments.map((segment) => encodeURIComponent(segment)).join("/")}`
    : undefined;
}

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
