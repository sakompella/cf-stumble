import { describe, expect, it, vi } from "vitest";
import {
  githubTokenForIsolateEgress,
  ISOLATE_EGRESS_ORIGINS,
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
  it("forwards an allowed host to the upstream", async () => {
    const up = upstream(() => new Response("body"));

    const response = await isolateEgressFetch(up.fetch)("https://github.com/owner/repo");

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("body");
    expect(up.seen).toHaveLength(1);
    expect(up.seen[0]?.request.url).toBe("https://github.com/owner/repo");
  });

  it("allows every origin it advertises", async () => {
    const up = upstream(() => new Response("body"));
    const gateway = isolateEgressFetch(up.fetch);

    for (const origin of ISOLATE_EGRESS_ORIGINS) {
      const response = await gateway(`${origin}/path`);

      expect(response.status, origin).toBe(200);
    }
  });

  it("forwards no header from the request, so no token reaches the upstream", async () => {
    const up = upstream(() => new Response("body"));

    await isolateEgressFetch(up.fetch)(
      new Request("https://api.github.com/repos/owner/repo", {
        headers: {
          authorization: "Bearer github-token",
          cookie: "session=secret",
          "x-custom": "value",
        },
      }),
    );

    const forwarded = up.seen[0]?.request;

    expect(forwarded?.headers.get("authorization")).toBeNull();
    expect(forwarded?.headers.get("cookie")).toBeNull();
    expect(forwarded?.headers.get("x-custom")).toBeNull();
    expect(forwarded?.headers.get("user-agent")).toBe("cf-stumble-isolate");
  });
});

describe("the isolate egress gateway refusals", () => {
  it.each([
    "https://example.com",
    "https://evil.github.com.attacker.dev",
    "http://github.com",
    "ftp://github.com",
    "not a url",
  ])("refuses %s with a clear error", async (url) => {
    const up = upstream(() => new Response("body"));

    const response = await isolateEgressFetch(up.fetch)(url);

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await response.text()).toContain("isolate egress");
    expect(up.seen).toHaveLength(0);
  });

  it("refuses a method other than GET and HEAD", async () => {
    const up = upstream(() => new Response("body"));

    const response = await isolateEgressFetch(up.fetch)("https://github.com/", {
      method: "POST",
    });

    expect(response.status).toBe(405);
    expect(up.seen).toHaveLength(0);
  });

  it("logs a refusal with the host", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const up = upstream(() => new Response("body"));

    try {
      await isolateEgressFetch(up.fetch)("https://example.com/path");

      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "workspace.isolate-egress.refused",
          reason: "host-not-allowed",
          host: "example.com",
        }),
      );
    } finally {
      warn.mockRestore();
    }
  });
});

describe("the isolate egress gateway redirects", () => {
  it("follows a redirect to an allowed host", async () => {
    const redirected = upstream((request) =>
      request.url.startsWith("https://raw.githubusercontent.com/")
        ? new Response("content")
        : new Response(null, {
            status: 302,
            headers: { location: "https://raw.githubusercontent.com/owner/repo/main/file.txt" },
          }),
    );

    const followed = await isolateEgressFetch(redirected.fetch)(
      "https://github.com/owner/repo/raw/main/file.txt",
    );

    expect(await followed.text()).toBe("content");
  });

  it("refuses a redirect to any other host", async () => {
    const escaped = upstream(
      () => new Response(null, { status: 302, headers: { location: "https://example.dev/leak" } }),
    );

    const refused = await isolateEgressFetch(escaped.fetch)("https://github.com/");

    expect(refused.status).toBe(403);
    expect(escaped.seen).toHaveLength(1);
  });
});

describe("the isolate egress gateway GitHub token", () => {
  it("sends the token only to api.github.com", async () => {
    const up = upstream(() => new Response("body"));
    const gateway = isolateEgressFetch(up.fetch, "github-token");

    await gateway("https://api.github.com/repos/owner/repo");
    await gateway("https://github.com/owner/repo");
    await gateway("https://raw.githubusercontent.com/owner/repo/main/file.txt");

    expect(up.seen[0]?.request.headers.get("authorization")).toBe("Bearer github-token");
    expect(up.seen[1]?.request.headers.get("authorization")).toBeNull();
    expect(up.seen[2]?.request.headers.get("authorization")).toBeNull();
  });

  it("goes out unauthenticated when there is no token", async () => {
    const up = upstream(() => new Response("body"));

    await isolateEgressFetch(up.fetch)("https://api.github.com/repos/owner/repo");

    expect(up.seen[0]?.request.headers.get("authorization")).toBeNull();
  });

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
