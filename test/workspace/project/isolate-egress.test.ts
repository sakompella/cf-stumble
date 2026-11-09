import { describe, expect, it } from "vitest";
import {
  githubTokenForIsolateEgress,
  isolateEgressFetch,
} from "../../../src/workspace/project/isolate-egress.js";

type Recorded = { request: Request };

function upstream(response: (request: Request) => Response) {
  const seen: Recorded[] = [];

  return {
    seen,
    fetch: (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);

      seen.push({ request });

      return Promise.resolve(response(request));
    },
  };
}

describe("the isolate egress gateway forwarding", () => {
  it("forwards any host to the upstream", async () => {
    const up = upstream(() => new Response("body"));
    const gateway = isolateEgressFetch(up.fetch);

    for (const url of [
      "https://example.com/path",
      "http://example.com/path",
      "https://api.github.com/repos",
    ]) {
      const response = await gateway(url);

      expect(response.status).toBe(200);
      expect(await response.text()).toBe("body");
    }

    expect(up.seen.map((entry) => entry.request.url)).toEqual([
      "https://example.com/path",
      "http://example.com/path",
      "https://api.github.com/repos",
    ]);
  });

  it("forwards any method with its body", async () => {
    const up = upstream(() => new Response("body"));

    const response = await isolateEgressFetch(up.fetch)("https://example.com/api", {
      method: "POST",
      body: "payload",
    });

    expect(response.status).toBe(200);
    expect(up.seen[0]?.request.method).toBe("POST");
    expect(await up.seen[0]?.request.text()).toBe("payload");
  });

  it("passes the request's headers through", async () => {
    const up = upstream(() => new Response("body"));

    await isolateEgressFetch(up.fetch)(
      new Request("https://example.com/", {
        headers: {
          authorization: "Bearer caller-token",
          cookie: "session=secret",
          "x-custom": "value",
        },
      }),
    );

    const forwarded = up.seen[0]?.request;

    expect(forwarded?.headers.get("authorization")).toBe("Bearer caller-token");
    expect(forwarded?.headers.get("cookie")).toBe("session=secret");
    expect(forwarded?.headers.get("x-custom")).toBe("value");
  });
});

describe("the isolate egress gateway redirects", () => {
  it("follows a redirect to any host with the method and body", async () => {
    const redirected = upstream((request) =>
      request.url.startsWith("https://other.example/")
        ? new Response("content")
        : new Response(null, { status: 302, headers: { location: "https://other.example/leak" } }),
    );

    const followed = await isolateEgressFetch(redirected.fetch)("https://example.com/", {
      method: "POST",
      body: "payload",
    });

    expect(await followed.text()).toBe("content");
    expect(redirected.seen[1]?.request.url).toBe("https://other.example/leak");
    expect(redirected.seen[1]?.request.method).toBe("POST");
    expect(await redirected.seen[1]?.request.text()).toBe("payload");
  });

  it("returns a redirect it cannot resolve", async () => {
    const up = upstream(
      () => new Response(null, { status: 302, headers: { location: "http://[invalid" } }),
    );

    const response = await isolateEgressFetch(up.fetch)("https://example.com/");

    expect(response.status).toBe(302);
    expect(up.seen).toHaveLength(1);
  });

  it("stops after too many redirects", async () => {
    const looped = upstream(
      (request) => new Response(null, { status: 302, headers: { location: `${request.url}x` } }),
    );

    const response = await isolateEgressFetch(looped.fetch)("https://example.com/");

    expect(response.status).toBe(508);
    expect(looped.seen).toHaveLength(6);
  });
});

describe("the isolate egress gateway GitHub token", () => {
  it("sends the token only to api.github.com", async () => {
    const up = upstream(() => new Response("body"));
    const gateway = isolateEgressFetch(up.fetch, "github-token");

    await gateway("https://api.github.com/repos/owner/repo");
    await gateway("https://github.com/owner/repo");
    await gateway("https://example.com/");

    expect(up.seen[0]?.request.headers.get("authorization")).toBe("Bearer github-token");
    expect(up.seen[1]?.request.headers.get("authorization")).toBeNull();
    expect(up.seen[2]?.request.headers.get("authorization")).toBeNull();
  });

  it("never overrides the request's own authorization header", async () => {
    const up = upstream(() => new Response("body"));

    await isolateEgressFetch(
      up.fetch,
      "github-token",
    )(
      new Request("https://api.github.com/repos/owner/repo", {
        headers: { authorization: "Basic dXNlcjpwYXNz" },
      }),
    );

    expect(up.seen[0]?.request.headers.get("authorization")).toBe("Basic dXNlcjpwYXNz");
  });

  it("goes out unauthenticated when there is no token", async () => {
    const up = upstream(() => new Response("body"));

    await isolateEgressFetch(up.fetch)("https://api.github.com/repos/owner/repo");

    expect(up.seen[0]?.request.headers.get("authorization")).toBeNull();
  });
});

describe("the isolate egress gateway GitHub token across redirects", () => {
  it("drops the token on a redirect from api.github.com to another origin", async () => {
    const redirected = upstream((request) =>
      request.url.startsWith("https://github.com/")
        ? new Response("content")
        : new Response(null, { status: 302, headers: { location: "https://github.com/leak" } }),
    );

    const followed = await isolateEgressFetch(
      redirected.fetch,
      "github-token",
    )("https://api.github.com/repos/owner/repo");

    expect(await followed.text()).toBe("content");
    expect(redirected.seen[0]?.request.headers.get("authorization")).toBe("Bearer github-token");
    expect(redirected.seen[1]?.request.headers.get("authorization")).toBeNull();
  });

  it("keeps the token on a redirect that stays on api.github.com", async () => {
    const redirected = upstream((request) =>
      request.url.includes("/moved")
        ? new Response(null, { status: 301, headers: { location: "https://api.github.com/final" } })
        : new Response("content"),
    );

    const followed = await isolateEgressFetch(
      redirected.fetch,
      "github-token",
    )("https://api.github.com/moved");

    expect(await followed.text()).toBe("content");
    expect(redirected.seen[0]?.request.headers.get("authorization")).toBe("Bearer github-token");
    expect(redirected.seen[1]?.request.headers.get("authorization")).toBe("Bearer github-token");
  });
});

const missingHostsFile = () => Promise.reject(new Error("ENOENT"));

describe("githubTokenForIsolateEgress", () => {
  it("reads the token from the gh hosts file", async () => {
    const token = await githubTokenForIsolateEgress(
      {
        readFile: () =>
          Promise.resolve("github.com:\n    oauth_token: ghp_fromHosts123\n    user: octocat\n"),
      },
      "fallback-token",
    );

    expect(token).toBe("ghp_fromHosts123");
  });

  it("ignores a token that belongs to another host", async () => {
    const token = await githubTokenForIsolateEgress({
      readFile: () =>
        Promise.resolve(
          "git.example.com:\n    oauth_token: ghp_otherHost123\ngithub.com:\n    user: octocat\n",
        ),
    });

    expect(token).toBeUndefined();
  });

  it("falls back to the configured token when the hosts file has none", async () => {
    const token = await githubTokenForIsolateEgress(
      { readFile: missingHostsFile },
      "fallback-token",
    );

    expect(token).toBe("fallback-token");
  });

  it("stays unauthenticated with no hosts file and no configured token", async () => {
    const token = await githubTokenForIsolateEgress({ readFile: missingHostsFile });

    expect(token).toBeUndefined();
  });
});
