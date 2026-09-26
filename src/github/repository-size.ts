// oxlint-disable anti-slop/no-unsafe-dictionary-type, anti-slop/no-known-value-widening, anti-slop/no-unknown-returns, anti-slop/no-runtime-typeof -- GitHub's JSON response is parsed at this API boundary.

import type { PublicRepositoryUrl } from "../project-catalog.js";
import type { GitHubFetch, GitHubToken } from "./device-flow.js";

/** Each API request has a short bound so a connection is not held by GitHub. */
export const REPOSITORY_SIZE_TIMEOUT_MS = 5_000;

const GITHUB_API_ROOT = "https://api.github.com/repos";

export type RepositorySizeLookup = Readonly<{
  sizeKb: number;
  blobCount: number;
  truncated: boolean;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function repositoryApiUrl(repositoryUrl: PublicRepositoryUrl): string | undefined {
  const url = new URL(repositoryUrl);
  const segments = url.pathname.split("/").filter((segment) => segment.length > 0);

  return url.hostname === "github.com" && segments.length === 2
    ? `${GITHUB_API_ROOT}/${segments.map((segment) => encodeURIComponent(segment)).join("/")}`
    : undefined;
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

  for (const entry of tree.tree) {
    if (isRecord(entry) && entry.type === "blob") blobCount += 1;
  }

  return { sizeKb: size, blobCount, truncated: tree.truncated };
}
