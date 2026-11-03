import * as Effect from "effect/Effect";
import { ORB_COMPUTERD_PATH, ORB_PROVIDER_PATH } from "../orb-protocol.js";

type OrbWorkspaceHost = Readonly<{ fetch(request: Request): Promise<Response> }>;

export function routeOrbRequest(
  request: Request,
  host: () => OrbWorkspaceHost,
): Effect.Effect<Response> | undefined {
  const { pathname } = new URL(request.url);

  if (pathname === ORB_PROVIDER_PATH || pathname === ORB_COMPUTERD_PATH)
    return Effect.promise(() => host().fetch(request));

  return undefined;
}
