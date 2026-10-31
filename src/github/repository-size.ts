import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { PublicRepositoryUrl } from "../project-catalog.js";
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

const API_HEADERS = {
  accept: "application/vnd.github+json",
  "user-agent": "cf-stumble",
  "x-github-api-version": "2022-11-28",
};

function apiHeaders(token: GitHubToken | undefined) {
  return token === undefined ? API_HEADERS : { ...API_HEADERS, authorization: `Bearer ${token}` };
}

export class RepositorySizeUnknown extends Data.TaggedError("RepositorySizeUnknown") {}

const ByteCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const Repository = Schema.Struct({ size: ByteCount, default_branch: Schema.NonEmptyString });

const Tree = Schema.Struct({ tree: Schema.Array(Schema.Unknown), truncated: Schema.Boolean });

const isBlob = Schema.is(Schema.Struct({ type: Schema.Literal("blob") }));

const decodeBlobSize = Schema.decodeUnknownOption(Schema.Struct({ size: ByteCount }));

function getJson<S extends Schema.ConstraintDecoder<unknown>>(
  url: string,
  token: GitHubToken | undefined,
  fetcher: GitHubFetch,
  reply: S,
): Effect.Effect<S["Type"], RepositorySizeUnknown> {
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

    const text = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: () => new RepositorySizeUnknown(),
    });

    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(reply))(text).pipe(
      Effect.mapError(() => new RepositorySizeUnknown()),
    );
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

    const repository = yield* getJson(apiUrl, token, fetcher, Repository);

    const tree = yield* getJson(
      `${apiUrl}/git/trees/${encodeURIComponent(repository.default_branch)}?recursive=1`,
      token,
      fetcher,
      Tree,
    );

    let blobCount = 0;
    let blobBytes = 0;

    for (const entry of tree.tree) {
      if (!isBlob(entry)) continue;

      const blobSize = decodeBlobSize(entry);

      if (Option.isNone(blobSize) || !Number.isSafeInteger(blobBytes + blobSize.value.size)) {
        return yield* new RepositorySizeUnknown();
      }

      blobCount += 1;
      blobBytes += blobSize.value.size;
    }

    return { sizeKb: repository.size, blobCount, blobBytes, truncated: tree.truncated };
  });
}
