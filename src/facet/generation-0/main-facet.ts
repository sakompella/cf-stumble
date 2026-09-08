/// <reference types="@cloudflare/workers-types" />

import { DurableObject } from "cloudflare:workers";
import { startFacetTurn } from "./facet-turn.js";
import { handleGeneration0Request } from "./request-handler.js";
import type { Generation0Capabilities } from "./capabilities.js";
import type { ProjectRpcTargetContract } from "../../workspace/project/protocol.js";

/**
 * Generation 0 of the main harness. The Supervisor mounts this class as a Dynamic Worker facet
 * under the labeled harness commit and relays ordinary requests to it (ADR-0024, ADR-0027).
 *
 * Its environment holds capabilities only. The class keeps no durable state of its own: the
 * conversation arrives with each turn and is stored outside every generation.
 */
export class MainFacet extends DurableObject<Generation0Capabilities> {
  override fetch(request: Request): Promise<Response> {
    // DELIBERATELY BROKEN. This branch exists to prove the deployed startup check: the Supervisor
    // builds this commit, cold-starts it, runs `GET /`, sees this, and leaves the active generation
    // serving. Never merge it.
    if (new URL(request.url).pathname === "/") {
      return Promise.resolve(
        new Response("this candidate is deliberately broken", { status: 500 }),
      );
    }
    return handleGeneration0Request(request);
  }

  /**
   * Run one turn in the tenant's workspace and stream the frames it produces.
   *
   * The project capability is an argument rather than an environment entry, and it has to be. A
   * Worker Loader entry is cached under the harness commit, so a project capability placed in
   * this facet's environment would be whichever project warmed that cache and would then serve
   * every other project from the same generation. Passing it per turn is also the only thing the
   * platform permits: an `RpcTarget` cannot be serialized into a Worker Loader's environment at
   * all, only handed across an RPC call.
   *
   * `workingDirectory` is where the turn starts, which is the selected project's directory inside
   * that workspace. The host derives it from its own catalog, so it arrives beside the untrusted
   * request rather than inside it.
   */
  startTurn(
    projectTarget: ProjectRpcTargetContract,
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Boundary: Durable Object RPC input is untrusted; `startFacetTurn` parses it.
    request: unknown,
    workingDirectory: string,
  ): ReadableStream<Uint8Array> {
    return startFacetTurn(this.env, projectTarget, request, workingDirectory);
  }
}
