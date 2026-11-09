import type { Workspace } from "@cloudflare/computer";
import * as Effect from "effect/Effect";
import { ORB_COMPUTERD_PATH, ORB_PROVIDER_PATH, ORB_TOKEN_HEADER } from "../orb-protocol.js";
import { forwardGit } from "./git-forward.js";
import { providerTokenMatches } from "./provider-token.js";

type Fetching = Readonly<{ handleFetch(request: Request): Promise<Response> }>;

const GIT_FORWARD_TOKEN_KEY = "git-forward-token";

export function gitForwardToken(kv: DurableObjectStorage["kv"]): string {
  const stored = kv.get<string>(GIT_FORWARD_TOKEN_KEY);

  if (stored !== undefined) return stored;

  const token = crypto.randomUUID();

  kv.put(GIT_FORWARD_TOKEN_KEY, token);

  return token;
}

const GIT_FORWARD_PATH = "/git";

type FetchRoutes = Readonly<{
  token: string | undefined;
  git: Readonly<{ token: string; workspace: Workspace; backendId: string }>;
  provider: Readonly<{ accept(): Response }>;
  container: Fetching;
  computerd: Fetching | undefined;
}>;

function refused(body: string, status: number): Effect.Effect<Response> {
  return Effect.succeed(new Response(body, { status }));
}

function accepted(
  request: Request,
  pathname: string,
  routes: FetchRoutes,
): Effect.Effect<Response> {
  if (request.headers.get("upgrade") !== "websocket")
    return refused("websocket upgrade required", 426);

  if (pathname === ORB_PROVIDER_PATH) return Effect.sync(() => routes.provider.accept());

  const { computerd } = routes;

  if (computerd === undefined) return refused("no provider container", 404);

  return Effect.promise(() =>
    computerd.handleFetch(new Request("http://computer.internal/api", request)),
  );
}

function bearerOf(request: Request): string | null {
  return /^Bearer (\S+)$/u.exec(request.headers.get("authorization") ?? "")?.[1] ?? null;
}

function forwardedGit(request: Request, routes: FetchRoutes): Effect.Effect<Response> {
  if (request.method !== "POST") return refused("POST required", 405);

  return providerTokenMatches(routes.git.token, bearerOf(request)).pipe(
    Effect.flatMap((matches) =>
      matches
        ? Effect.promise(async () =>
            forwardGit(routes.git.workspace, routes.git.backendId, await request.text()),
          )
        : refused("unauthorized", 401),
    ),
  );
}

export function routeFetch(request: Request, routes: FetchRoutes): Effect.Effect<Response> {
  const { pathname } = new URL(request.url);

  if (pathname === GIT_FORWARD_PATH) return forwardedGit(request, routes);

  if (pathname !== ORB_PROVIDER_PATH && pathname !== ORB_COMPUTERD_PATH)
    return Effect.promise(() => routes.container.handleFetch(request));

  return providerTokenMatches(routes.token, request.headers.get(ORB_TOKEN_HEADER)).pipe(
    Effect.flatMap((matches) =>
      matches ? accepted(request, pathname, routes) : refused("unauthorized", 401),
    ),
  );
}
