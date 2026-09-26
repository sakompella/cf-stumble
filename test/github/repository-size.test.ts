import { expect, test } from "vitest";
import { parsePublicRepositoryUrl } from "../../src/project-catalog.js";
import { lookupRepositorySize } from "../../src/github/repository-size.js";
import { parseGitHubToken } from "../../src/github/device-flow.js";

const repository = parsePublicRepositoryUrl("https://github.com/owner/repo");

const token = parseGitHubToken("ghp_test-token");

if (repository === undefined || token === undefined) {
  throw new Error("the test values must be valid");
}

test("looks up the GitHub repository size with the configured credential", async () => {
  const requested: { url: string; init: RequestInit | undefined }[] = [];

  const size = await lookupRepositorySize(repository, token, (url, init) => {
    requested.push({ url, init });

    return Promise.resolve(
      requested.length === 1
        ? Response.json({ size: 1234, default_branch: "main" })
        : Response.json({
            truncated: false,
            tree: [{ type: "blob" }, { type: "tree" }, { type: "blob" }],
          }),
    );
  });

  expect(size).toEqual({ sizeKb: 1234, blobCount: 2, truncated: false });
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

  const size = await lookupRepositorySize(repository, undefined, (_url, init) => {
    requestedInit = init;
    count += 1;

    return Promise.resolve(
      count === 1
        ? Response.json({ size: 7, default_branch: "trunk" })
        : Response.json({ truncated: false, tree: [] }),
    );
  });

  expect(size).toEqual({ sizeKb: 7, blobCount: 0, truncated: false });
  expect(new Headers(requestedInit?.headers).has("authorization")).toBe(false);
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
  await expect(lookupRepositorySize(repository, undefined, fetcher)).resolves.toBeUndefined();
});

test("skips a malformed tree response", async () => {
  let count = 0;

  await expect(
    lookupRepositorySize(repository, undefined, () => {
      count += 1;

      return Promise.resolve(
        count === 1
          ? Response.json({ size: 1, default_branch: "main" })
          : Response.json({ truncated: true }),
      );
    }),
  ).resolves.toBeUndefined();
});
