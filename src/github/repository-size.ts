// oxlint-disable anti-slop/no-known-value-widening, anti-slop/no-unknown-returns, anti-slop/no-runtime-typeof -- GitHub's JSON response is parsed at this API boundary.

import type { PublicRepositoryUrl } from "../project-catalog.js";
import { isRecord } from "../untrusted.js";
import type { GitHubFetch, GitHubToken } from "./device-flow.js";

/** Each API request has a short bound so a connection is not held by GitHub. */
export const REPOSITORY_SIZE_TIMEOUT_MS = 5_000;

const GITHUB_API_ROOT = "https://api.github.com";

/**
 * A full-tree file ceiling protects the per-file durable workspace index and sync walk. Hono's
 * measured 1,800-file tree stayed healthy, while workers-sdk wedged at 5,649 files, so 3,000
 * leaves useful margin above the largest healthy repository and refuses the observed failure class.
 */
export const MAX_REPOSITORY_BLOB_COUNT = 3_000;

/**
 * The working tree byte ceiling keeps durable sync below the observed wedge. Hono's working tree
 * was about 6 MB and workers-sdk's was about 48 MB locally (162 MB of Git data); 150 MB leaves
 * margin for a larger healthy tree without admitting a repository that can overwhelm the workspace.
 * GitHub reports a tree entry's `size` in bytes.
 */
export const MAX_REPOSITORY_BLOB_BYTES = 150_000_000;

/**
 * The history-size ceiling remains separate from the current working-tree byte ceiling. GitHub
 * reports a repository's `size` in kilobytes.
 */
export const MAX_REPOSITORY_SIZE_KB = 5_000_000;

/** A truncated tree cannot prove the file count, so it is not safe to connect. */
export const REPOSITORY_TREE_MUST_BE_COMPLETE = true;

export type RepositorySizeReason =
  | "tree-truncated"
  | "too-many-files"
  | "working-tree-too-large"
  | "repository-too-large"
  | "within-limits";

export type RepositorySizeLookup = Readonly<{
  sizeKb: number;
  blobCount: number;
  blobBytes: number;
  truncated: boolean;
}>;

/** Apply the workspace size ceilings to one measurement, in the order the reasons are reported. */
export function repositorySizeReason(measured: RepositorySizeLookup): RepositorySizeReason {
  if (REPOSITORY_TREE_MUST_BE_COMPLETE && measured.truncated) return "tree-truncated";

  if (measured.blobCount > MAX_REPOSITORY_BLOB_COUNT) return "too-many-files";

  if (measured.blobBytes > MAX_REPOSITORY_BLOB_BYTES) return "working-tree-too-large";

  if (measured.sizeKb > MAX_REPOSITORY_SIZE_KB) return "repository-too-large";

  return "within-limits";
}

/** The REST path of one repository, such as `repos/owner/name`, as both `fetch` and `gh api` use it. */
export function repositoryApiPath(repositoryUrl: PublicRepositoryUrl): string | undefined {
  const url = new URL(repositoryUrl);
  const segments = url.pathname.split("/").filter((segment) => segment.length > 0);

  return url.hostname === "github.com" && segments.length === 2
    ? `repos/${segments.map((segment) => encodeURIComponent(segment)).join("/")}`
    : undefined;
}

function repositoryApiUrl(repositoryUrl: PublicRepositoryUrl): string | undefined {
  const path = repositoryApiPath(repositoryUrl);

  return path === undefined ? undefined : `${GITHUB_API_ROOT}/${path}`;
}

function apiHeaders(token: GitHubToken | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "cf-stumble",
    "x-github-api-version": "2022-11-28",
  };

  if (token !== undefined) headers.authorization = `Bearer ${token}`;

  return headers;
}

async function getJson(
  url: string,
  token: GitHubToken | undefined,
  fetcher: GitHubFetch,
): Promise<unknown> {
  try {
    const response = await fetcher(url, {
      headers: apiHeaders(token),
      signal: AbortSignal.timeout(REPOSITORY_SIZE_TIMEOUT_MS),
    });

    return response.ok ? await response.json() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Read GitHub's repository size and working-tree blob count. Any failed, rate-limited, or
 * malformed response is unknown, not a connection refusal: cloning remains the final check.
 */
export async function lookupRepositorySize(
  repositoryUrl: PublicRepositoryUrl,
  token: GitHubToken | undefined,
  fetcher: GitHubFetch,
): Promise<RepositorySizeLookup | undefined> {
  const apiUrl = repositoryApiUrl(repositoryUrl);

  if (apiUrl === undefined) return undefined;

  const repository = await getJson(apiUrl, token, fetcher);
  const size = isRecord(repository) ? repository.size : undefined;
  const defaultBranch = isRecord(repository) ? repository.default_branch : undefined;

  if (
    typeof size !== "number" ||
    !Number.isSafeInteger(size) ||
    size < 0 ||
    typeof defaultBranch !== "string" ||
    defaultBranch.length === 0
  ) {
    return undefined;
  }

  const tree = await getJson(
    `${apiUrl}/git/trees/${encodeURIComponent(defaultBranch)}?recursive=1`,
    token,
    fetcher,
  );

  if (!isRecord(tree) || !Array.isArray(tree.tree) || typeof tree.truncated !== "boolean") {
    return undefined;
  }

  let blobCount = 0;
  let blobBytes = 0;

  for (const entry of tree.tree) {
    if (!isRecord(entry) || entry.type !== "blob") continue;

    const blobSize = entry.size;

    if (
      typeof blobSize !== "number" ||
      !Number.isSafeInteger(blobSize) ||
      blobSize < 0 ||
      !Number.isSafeInteger(blobBytes + blobSize)
    ) {
      return undefined;
    }

    blobCount += 1;
    blobBytes += blobSize;
  }

  return { sizeKb: size, blobCount, blobBytes, truncated: tree.truncated };
}
