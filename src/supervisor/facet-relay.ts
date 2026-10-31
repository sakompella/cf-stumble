import * as Result from "effect/Result";
import { isTimeoutFailure, logRedactedCause } from "../diagnostics.js";
import type { MainFacetMountProblem, MountedFacet } from "./artifacts/index.js";

export async function forwardToFacet(
  request: Request,
  fetcher: Pick<Fetcher, "fetch">,
): Promise<Response> {
  try {
    return await fetcher.fetch(request);
  } catch (cause) {
    logRedactedCause(
      `supervisor.relay.forward ${request.method} ${new URL(request.url).pathname}: ${
        isTimeoutFailure(cause) ? "timeout" : "main-facet-failed-before-headers"
      }`,
      cause,
    );

    return new Response("Main facet failed before response headers", { status: 502 });
  }
}

export function relayToMainFacet(
  request: Request,
  mainFacet: Result.Result<MountedFacet, MainFacetMountProblem>,
): Promise<Response> {
  if (Result.isFailure(mainFacet)) {
    const { code } = mainFacet.failure;

    return Promise.resolve(
      code === "no-active-generation"
        ? Response.json({ ok: false, problem: { code } }, { status: 503 })
        : new Response("Cannot mount main facet", { status: 500 }),
    );
  }

  return forwardToFacet(request, mainFacet.success);
}
