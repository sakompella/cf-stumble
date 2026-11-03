import * as Effect from "effect/Effect";
import { ORB_COMPUTERD_PATH, ORB_PROVIDER_PATH } from "../orb-protocol.js";

const ORB_TOKEN_PATH = "/api/orb/provider-token";

type OrbWorkspaceHost = Readonly<{
  fetch(request: Request): Promise<Response>;
  mintProviderToken(): Promise<string>;
}>;

export function routeOrbRequest(
  request: Request,
  host: () => OrbWorkspaceHost,
): Effect.Effect<Response> | undefined {
  const { pathname } = new URL(request.url);

  if (pathname === ORB_PROVIDER_PATH || pathname === ORB_COMPUTERD_PATH)
    return Effect.promise(() => host().fetch(request));

  if (request.method === "POST" && pathname === ORB_TOKEN_PATH)
    return Effect.promise(async () =>
      Response.json(
        { token: await host().mintProviderToken() },
        { headers: { "cache-control": "no-store" } },
      ),
    );

  return undefined;
}
