import * as Effect from "effect/Effect";
import { ORB_COMPUTERD_PATH, ORB_PROVIDER_PATH, ORB_TOKEN_HEADER } from "../orb-protocol.js";
import { providerTokenMatches } from "./provider-token.js";

type Fetching = Readonly<{ handleFetch(request: Request): Promise<Response> }>;

type FetchRoutes = Readonly<{
  token: string | undefined;
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

export function routeFetch(request: Request, routes: FetchRoutes): Effect.Effect<Response> {
  const { pathname } = new URL(request.url);

  if (pathname !== ORB_PROVIDER_PATH && pathname !== ORB_COMPUTERD_PATH)
    return Effect.promise(() => routes.container.handleFetch(request));

  return providerTokenMatches(routes.token, request.headers.get(ORB_TOKEN_HEADER)).pipe(
    Effect.flatMap((matches) =>
      matches ? accepted(request, pathname, routes) : refused("unauthorized", 401),
    ),
  );
}
