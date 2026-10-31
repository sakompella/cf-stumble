// oxlint-disable anti-slop/no-known-value-widening, anti-slop/no-unknown-returns, anti-slop/no-runtime-typeof -- GitHub's JSON response is parsed at this API boundary.

import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type { PublicRepositoryUrl } from "../project-catalog.js";
import { isRecord } from "../untrusted.js";
import type { GitHubFetch, GitHubToken } from "./device-flow.js";

export const REPOSITORY_SIZE_TIMEOUT_MS = 5_000;

const GITHUB_API_ROOT = "https://api.github.com";

export const MAX_REPOSITORY_BLOB_COUNT = 3_000;

export const MAX_REPOSITORY_BLOB_BYTES = 150_000_000;

export const MAX_REPOSITORY_SIZE_KB = 5_000_000;

export const REPOSITORY_TREE_MUST_BE_COMPLETE = true;

export type RepositorySizeReason =
  | "tree-truncated"
  | "too-many-files"
  | "working-tree-too-large"
  | "repository-too-large"
  | "within-limits";

type RepositorySizeLookup = Readonly<{
  sizeKb: number;
  blobCount: number;
  blobBytes: number;
  truncated: boolean;
}>;

export function repositorySizeReason(measured: RepositorySizeLookup): RepositorySizeReason {
  if (REPOSITORY_TREE_MUST_BE_COMPLETE && measured.truncated) return "tree-truncated";

  if (measured.blobCount > MAX_REPOSITORY_BLOB_COUNT) return "too-many-files";

  if (measured.blobBytes > MAX_REPOSITORY_BLOB_BYTES) return "working-tree-too-large";

  if (measured.sizeKb > MAX_REPOSITORY_SIZE_KB) return "repository-too-large";

  return "within-limits";
}

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

export class RepositorySizeUnknown extends Data.TaggedError("RepositorySizeUnknown") {}

function getJson(
  url: string,
  token: GitHubToken | undefined,
  fetcher: GitHubFetch,
): Effect.Effect<unknown, RepositorySizeUnknown> {
  return Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () =>
        fetcher(url, {
          headers: apiHeaders(token),
          signal: AbortSignal.timeout(REPOSITORY_SIZE_TIMEOUT_MS),
        }),
      catch: () => new RepositorySizeUnknown(),
    });

    if (!response.ok) return yield* new RepositorySizeUnknown();

    return yield* Effect.tryPromise({
      try: (): Promise<unknown> => response.json(),
      catch: () => new RepositorySizeUnknown(),
    });
  });
}

export function lookupRepositorySize(
  repositoryUrl: PublicRepositoryUrl,
  token: GitHubToken | undefined,
  fetcher: GitHubFetch,
): Effect.Effect<RepositorySizeLookup, RepositorySizeUnknown> {
  return Effect.gen(function* () {
    const apiUrl = repositoryApiUrl(repositoryUrl);

    if (apiUrl === undefined) return yield* new RepositorySizeUnknown();

    const repository = yield* getJson(apiUrl, token, fetcher);
    const size = isRecord(repository) ? repository.size : undefined;
    const defaultBranch = isRecord(repository) ? repository.default_branch : undefined;

    if (
      typeof size !== "number" ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      typeof defaultBranch !== "string" ||
      defaultBranch.length === 0
    ) {
      return yield* new RepositorySizeUnknown();
    }

    const tree = yield* getJson(
      `${apiUrl}/git/trees/${encodeURIComponent(defaultBranch)}?recursive=1`,
      token,
      fetcher,
    );

    if (!isRecord(tree) || !Array.isArray(tree.tree) || typeof tree.truncated !== "boolean") {
      return yield* new RepositorySizeUnknown();
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
        return yield* new RepositorySizeUnknown();
      }

      blobCount += 1;
      blobBytes += blobSize;
    }

    return { sizeKb: size, blobCount, blobBytes, truncated: tree.truncated };
  });
}
