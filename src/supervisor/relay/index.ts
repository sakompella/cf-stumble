import { isTimeoutFailure, logRedactedCause } from "../../diagnostics.js";
import type { MainFacetMountProblem } from "../artifacts/index.js";

/**
 * The Supervisor's path to the generation that serves. It forwards the request to the facet and
 * hands the facet's own response back, so the caller sees the same status, headers and bytes.
 *
 * A mount failure with no active generation is not a fault: the Supervisor holds no built-in code,
 * so there is nothing to serve until the owner submits a harness commit and activates the
 * generation the Supervisor labels. It answers 503 and says so. Every other mount failure is a
 * fault of the generation that is active, and answers 500.
 */
export class FacetRelay {
  async forward(request: Request, fetcher: Pick<Fetcher, "fetch">): Promise<Response> {
    try {
      return await fetcher.fetch(request);
    } catch (cause) {
      // The caller sees only the generic 502 below, on purpose (ADR-0035): a broken generation
      // and a Loader or RPC transport failure must look identical from outside. An operator
      // still needs to tell them apart, so the discarded cause is logged, redacted, with the
      // request line, which is all the activation context this module receives.
      logRedactedCause(
        `supervisor.relay.forward ${request.method} ${new URL(request.url).pathname}: ${
          isTimeoutFailure(cause) ? "timeout" : "main-facet-failed-before-headers"
        }`,
        cause,
      );

      return new Response("Main facet failed before response headers", { status: 502 });
    }
  }

  mountFailureResponse(problem: MainFacetMountProblem): Response {
    return problem.code === "no-active-generation"
      ? Response.json({ ok: false, problem: { code: problem.code } }, { status: 503 })
      : new Response("Cannot mount main facet", { status: 500 });
  }
}
