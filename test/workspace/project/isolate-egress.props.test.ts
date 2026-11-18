import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { expect, test } from "vitest";
import { readGitHubToken } from "../../../src/workspace/project/github-remote.js";
import { isolateEgressFetch } from "../../../src/workspace/project/isolate-egress.js";

const ORIGINS = [
  "https://api.github.com",
  "https://github.com",
  "https://example.com",
  "http://example.com",
] as const;

const REDIRECT_STATUSES = [301, 302, 303, 307, 308] as const;

type Location =
  | Readonly<{ kind: "absolute"; origin: string }>
  | Readonly<{ kind: "relative" }>
  | Readonly<{ kind: "unresolvable" }>;

type Hop = Readonly<{
  url: string;
  method: string;
  body: string | null;
  contentType: string | null;
  authorization: string | null;
  cookie: string | null;
  custom: string | null;
}>;

type Caller = Readonly<{
  authorization: string | null;
  cookie: string | null;
  token: string | undefined;
}>;

type Sent = Readonly<{ method: string; body: string | undefined; asRequest: boolean }>;

const location: gs.Generator<Location> = gs.oneOf<Location>(
  gs.sampledFrom(ORIGINS).map((origin) => ({ kind: "absolute" as const, origin })),
  gs.just({ kind: "relative" as const }),
  gs.just({ kind: "unresolvable" as const }),
);

function locationHeader(next: Location, hop: number): string {
  if (next.kind === "absolute") return `${next.origin}/hop-${hop}`;

  return next.kind === "relative" ? `/hop-${hop}` : "http://[unresolvable";
}

function redirectedAsGet(status: number, method: string): boolean {
  if (status === 303) return method !== "GET" && method !== "HEAD";

  return (status === 301 || status === 302) && method === "POST";
}

function expectedHops(start: string, chain: readonly Location[], caller: Caller, sent: Sent) {
  const hops: Hop[] = [];
  let origin = start;
  let url = `${start}/start`;
  let crossedOrigin = false;
  let method = sent.method;
  let body = sent.body ?? null;

  for (let hop = 0; hop < 6; hop++) {
    const carried = crossedOrigin ? null : caller.authorization;
    const token = origin === "https://api.github.com" ? caller.token : undefined;
    const authorization = carried ?? (token === undefined ? null : `Bearer ${token}`);
    const contentType = body === null ? null : "text/plain";
    hops.push({
      url,
      method,
      body,
      contentType,
      authorization,
      cookie: crossedOrigin ? null : caller.cookie,
      custom: "value",
    });
    const next = chain[hop];
    const status = REDIRECT_STATUSES[hop % REDIRECT_STATUSES.length]!;

    if (next === undefined) return { hops, status: 200 };

    if (next.kind === "unresolvable") return { hops, status };

    if (redirectedAsGet(status, method)) {
      method = "GET";
      body = null;
    }

    const nextOrigin = next.kind === "absolute" ? next.origin : origin;
    crossedOrigin ||= nextOrigin !== origin;
    origin = nextOrigin;
    url = `${origin}/hop-${hop}`;
  }

  return { hops, status: 508 };
}

function redirectingUpstream(chain: readonly Location[]) {
  const seen: Hop[] = [];

  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const { body, ...head } = init ?? {};
    const request = new Request(input, head);
    const hop = seen.length;
    seen.push({
      url: request.url,
      method: request.method,
      body: body === undefined || body === null ? null : await new Response(body).text(),
      contentType: request.headers.get("content-type"),
      authorization: request.headers.get("authorization"),
      cookie: request.headers.get("cookie"),
      custom: request.headers.get("x-custom"),
    });
    const next = chain[hop];

    if (next === undefined) return new Response("final");
    const status = REDIRECT_STATUSES[hop % REDIRECT_STATUSES.length]!;

    return new Response(null, { status, headers: { location: locationHeader(next, hop) } });
  };

  return { seen, fetch };
}

function drawCaller(tc: hegel.TestCase): Caller {
  return {
    authorization: tc.draw(gs.sampledFrom([null, "Bearer caller-token", "Basic dXNlcjpwYXNz"])),
    cookie: tc.draw(gs.sampledFrom([null, "session=secret"])),
    token: tc.draw(gs.sampledFrom([undefined, "github-token"])),
  };
}

function callerHeaders(caller: Caller): Headers {
  const headers = new Headers({ "x-custom": "value" });

  if (caller.authorization !== null) headers.set("authorization", caller.authorization);

  if (caller.cookie !== null) headers.set("cookie", caller.cookie);

  return headers;
}

function callerRequest(url: string, caller: Caller, { method, body, asRequest }: Sent) {
  const headers = callerHeaders(caller);
  const init: RequestInit = { method, headers };

  if (body !== undefined) {
    headers.set("content-type", "text/plain");
    init.body = body;
  }

  if (asRequest) return { input: new Request(url, init), init: undefined };

  return { input: url, init };
}

test("the gateway follows any redirect chain as fetch does, resending the caller's body and switching to a bodiless GET on a 303 and on a 301 or 302 after a POST, sending the GitHub token only to api.github.com and the caller's credentials only until the first cross-origin hop", async () => {
  await hegel.testAsync(
    async (tc) => {
      const start = tc.draw(gs.sampledFrom(ORIGINS));
      const chain = tc.draw(gs.arrays(location, { maxSize: 8 }));
      const caller = drawCaller(tc);
      const method = tc.draw(gs.sampledFrom(["GET", "HEAD", "POST", "PUT"]));
      const bodyless = method === "GET" || method === "HEAD";

      const body = bodyless ? undefined : tc.draw(gs.text({ maxSize: 12 }));

      const upstream = redirectingUpstream(chain);
      const sent = { method, body, asRequest: tc.draw(gs.booleans()) };
      const { input, init } = callerRequest(`${start}/start`, caller, sent);

      const response = await isolateEgressFetch(upstream.fetch, caller.token)(input, init);
      const expected = expectedHops(start, chain, caller, sent);

      expect(upstream.seen).toEqual(expected.hops);
      expect(response.status).toBe(expected.status);

      if (expected.status === 200) expect(await response.text()).toBe("final");
    },
    { testCases: 300 },
  );
});

const HOSTS_FILES = {
  missing: undefined,
  "a github.com token": "github.com:\n    oauth_token: ghp_fromHosts123\n    user: octocat\n",
  "a token for another host only":
    "git.example.com:\n    oauth_token: ghp_otherHost123\ngithub.com:\n    user: octocat\n",
  "no token": "github.com:\n    user: octocat\n",
} as const;

test("the egress token is the gh hosts file's github.com token, else the configured token", async () => {
  await hegel.testAsync(async (tc) => {
    const hostsFile = tc.draw(gs.sampledFrom(Object.values(HOSTS_FILES)));
    const configured = tc.draw(gs.sampledFrom([undefined, "configured-token"]));

    const token = await readGitHubToken(
      {
        readFile: () =>
          hostsFile === undefined
            ? Promise.reject(new Error("ENOENT"))
            : Promise.resolve(hostsFile),
      },
      configured,
    );

    expect(token).toBe(
      hostsFile === HOSTS_FILES["a github.com token"] ? "ghp_fromHosts123" : configured,
    );
  });
});
