import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { logRedactedCause } from "../diagnostics.js";
import { ORB_COMPUTERD_PATH, ORB_PROVIDER_PATH } from "../orb-protocol.js";

class WorkspaceHostUnreachable extends Data.TaggedError("WorkspaceHostUnreachable")<{
  readonly cause: unknown;
}> {}

type OrbWorkspaceHost = Readonly<{ fetch(request: Request): Promise<Response> }>;

export function routeOrbRequest(
  request: Request,
  host: () => OrbWorkspaceHost,
): Effect.Effect<Response> | undefined {
  const { pathname } = new URL(request.url);

  if (pathname === ORB_PROVIDER_PATH || pathname === ORB_COMPUTERD_PATH)
    return Effect.tryPromise({
      try: () => host().fetch(request),
      catch: (cause) => new WorkspaceHostUnreachable({ cause }),
    }).pipe(
      Effect.catch(({ cause }) =>
        Effect.sync(() => {
          logRedactedCause("routes.orb: workspace-host-unavailable", cause);

          return new Response("the Workspace Host is unavailable", { status: 502 });
        }),
      ),
    );

  return undefined;
}
