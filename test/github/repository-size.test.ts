import * as Effect from "effect/Effect";
import { expect, test } from "vitest";
import { parsePublicRepositoryUrl, type PublicRepositoryUrl } from "../../src/project-catalog.js";
import { lookupRepositorySize } from "../../src/github/repository-size.js";
import {
  parseGitHubToken,
  type GitHubFetch,
  type GitHubToken,
} from "../../src/github/device-flow.js";

/** The lookup as the assertions compare it: the measurement, or nothing when it is unknown. */
function measure(
  repositoryUrl: PublicRepositoryUrl,
  credential: GitHubToken | undefined,
  fetcher: GitHubFetch,
) {
  return Effect.runPromise(
    lookupRepositorySize(repositoryUrl, credential, fetcher).pipe(
      Effect.catchTag("RepositorySizeUnknown", () => Effect.void),
    ),
  );
}

const repository = parsePublicRepositoryUrl("https://github.com/owner/repo");

const token = parseGitHubToken("ghp_test-token");

if (repository === undefined || token === undefined) {
  throw new Error("the test values must be valid");
}

test("looks up the GitHub repository size with the configured credential", async () => {
  const requested: { url: string; init: RequestInit | undefined }[] = [];

  const size = await measure(repository, token, (url, init) => {
    requested.push({ url, init });

    return Promise.resolve(
      requested.length === 1
        ? Response.json({ size: 1234, default_branch: "main" })
        : Response.json({
            truncated: false,
            tree: [{ type: "blob", size: 10 }, { type: "tree" }, { type: "blob", size: 20 }],
          }),
    );
  });

  expect(size).toEqual({ sizeKb: 1234, blobCount: 2, blobBytes: 30, truncated: false });
  expect(requested.map(({ url }) => url)).toEqual([
    "https://api.github.com/repos/owner/repo",
    "https://api.github.com/repos/owner/repo/git/trees/main?recursive=1",
  ]);
  expect(new Headers(requested[0]?.init?.headers).get("authorization")).toBe(
    "Bearer ghp_test-token",
  );
  expect(new Headers(requested[0]?.init?.headers).get("accept")).toBe(
    "application/vnd.github+json",
  );
});

test("allows a public repository lookup without a configured credential", async () => {
  let requestedInit: RequestInit | undefined;
  let count = 0;

  const size = await measure(repository, undefined, (_url, init) => {
    requestedInit = init;
    count += 1;

    return Promise.resolve(
      count === 1
        ? Response.json({ size: 7, default_branch: "trunk" })
        : Response.json({ truncated: false, tree: [] }),
    );
  });

  expect(size).toEqual({ sizeKb: 7, blobCount: 0, blobBytes: 0, truncated: false });
  const headers = new Headers(requestedInit?.headers);

  expect(headers.has("authorization")).toBe(false);
  // GitHub answers 403 to any request that has no User-Agent.
  expect(headers.get("user-agent")).toBeTruthy();
});

test.each([
  [
    "404",
    (_url: string, _init: RequestInit) => Promise.resolve(new Response(null, { status: 404 })),
  ],
  [
    "invalid payload",
    (_url: string, _init: RequestInit) => Promise.resolve(Response.json({ size: "large" })),
  ],
] as const)("skips a %s response", async (_name, fetcher) => {
  await expect(measure(repository, undefined, fetcher)).resolves.toBeUndefined();
});

test("skips a malformed tree response", async () => {
  let count = 0;

  await expect(
    measure(repository, undefined, () => {
      count += 1;

      return Promise.resolve(
        count === 1
          ? Response.json({ size: 1, default_branch: "main" })
          : Response.json({ truncated: true }),
      );
    }),
  ).resolves.toBeUndefined();
});

test("skips a tree with a malformed blob size", async () => {
  await expect(
    measure(repository, undefined, (url) =>
      Promise.resolve(
        url.includes("/git/trees/")
          ? Response.json({ truncated: false, tree: [{ type: "blob" }] })
          : Response.json({ size: 1, default_branch: "main" }),
      ),
    ),
  ).resolves.toBeUndefined();
});
