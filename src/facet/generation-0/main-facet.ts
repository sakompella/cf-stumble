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
    return handleGeneration0Request(request, this.env);
  }

  /**
   * Run one turn against one project workspace and stream the frames it produces.
   *
   * The project capability is an argument rather than an environment entry, and it has to be. A
   * Worker Loader entry is cached under the harness commit, so a project capability placed in
   * this facet's environment would be whichever project warmed that cache and would then serve
   * every other project from the same generation. Passing it per turn is also the only thing the
   * platform permits: an `RpcTarget` cannot be serialized into a Worker Loader's environment at
   * all, only handed across an RPC call.
   */
  startTurn(
    projectTarget: ProjectRpcTargetContract,
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Boundary: Durable Object RPC input is untrusted; `startFacetTurn` parses it.
    request: unknown,
  ): ReadableStream<Uint8Array> {
    return startFacetTurn(this.env, projectTarget, request);
  }
}
